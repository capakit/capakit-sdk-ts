import { Agent, request as requestHttp } from "node:http";
import type {
    ClientRequest,
    IncomingMessage,
    RequestOptions,
} from "node:http";

import { parseBind } from "./transport.ts";
import type { HostedBind } from "./public-types.ts";

const BRIDGE_CONTENT_TYPE = "application/x-capakit-workload-bridge-jsonl";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PARTIAL_FRAME_BYTES = MAX_FRAME_BYTES + 1;

type BridgeResponse = { id: string; ok: unknown } | { id: string; error: unknown };

type ClientGeneration = {
    agent: Agent;
    calls: Set<AbortController>;
};

export class WorkloadBridgeClient {
    private nextId = 1;
    private readonly bind: HostedBind;
    private generation: ClientGeneration | null = null;

    constructor(value: string) {
        this.bind = parseBind(value);
    }

    async call<Result>(op: string, params: unknown): Promise<Result> {
        const generation = this.currentGeneration();
        const controller = new AbortController();
        generation.calls.add(controller);
        try {
            const id = String(this.nextId++);
            const response = await this.send(
                id,
                { id, op, params },
                generation.agent,
                controller.signal,
            );
            if ("error" in response) {
                throw new Error(formatRpcError(response.error), {
                    cause: response.error,
                });
            }
            return response.ok as Result;
        } finally {
            generation.calls.delete(controller);
        }
    }

    async close(): Promise<void> {
        const generation = this.generation;
        this.generation = null;
        if (!generation) {
            return;
        }
        const reason = new Error("workload bridge client closed");
        for (const controller of generation.calls) {
            controller.abort(reason);
        }
        generation.agent.destroy();
    }

    private currentGeneration(): ClientGeneration {
        if (!this.generation) {
            this.generation = {
                agent: new Agent({ keepAlive: true }),
                calls: new Set(),
            };
        }
        return this.generation;
    }

    private async send(
        id: string,
        request: unknown,
        agent: Agent,
        signal: AbortSignal,
    ): Promise<BridgeResponse> {
        const frame = encodeJsonLine(request);
        let req: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        try {
            response = await new Promise<IncomingMessage>((resolve, reject) => {
                req = requestHttp(
                    bridgeRequestOptions(this.bind, frame.length, agent, signal),
                );
                req.once("response", resolve);
                req.once("error", reject);
                req.once("socket", (socket) => {
                    socket.setNoDelay?.(true);
                });
                req.end(frame);
            });
            validateBridgeResponse(response);
            return await readBridgeResponse(response, id);
        } catch (error) {
            const normalized = normalizeError(error);
            response?.destroy(normalized);
            req?.destroy(normalized);
            throw normalized;
        }
    }
}

function encodeJsonLine(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.length > MAX_FRAME_BYTES) {
        throw new Error("workload bridge request frame exceeds maximum size");
    }
    return Buffer.concat([body, Buffer.from("\n")]);
}

async function readBridgeResponse(
    response: IncomingMessage,
    id: string,
): Promise<BridgeResponse> {
    const parser = new JsonLineParser();
    let result: BridgeResponse | undefined;
    for await (const value of response) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        for (const item of parser.feed(chunk)) {
            const decoded = decodeBridgeResponse(item);
            if (decoded.id !== id) {
                throw new Error(
                    `workload bridge returned unexpected response id \`${decoded.id}\``,
                );
            }
            if (result) {
                throw new Error("workload bridge returned multiple response frames");
            }
            result = decoded;
        }
    }
    if (!response.complete) {
        throw new Error("workload bridge response terminated before completion");
    }
    if (parser.hasPartial()) {
        throw new Error("workload bridge response ended with an incomplete frame");
    }
    if (!result) {
        throw new Error("workload bridge response ended without a matching response");
    }
    return result;
}

class JsonLineParser {
    private parts: Buffer[] = [];
    private partialBytes = 0;

    feed(chunk: Buffer): unknown[] {
        const parsed: unknown[] = [];
        let offset = 0;
        while (offset < chunk.length) {
            const lineEnd = chunk.indexOf(0x0a, offset);
            if (lineEnd < 0) {
                this.append(chunk.subarray(offset));
                break;
            }
            this.append(chunk.subarray(offset, lineEnd));
            let body = Buffer.concat(this.parts, this.partialBytes);
            this.parts = [];
            this.partialBytes = 0;
            offset = lineEnd + 1;

            if (body.at(-1) === 0x0d) {
                body = body.subarray(0, body.length - 1);
            }
            if (body.length === 0) {
                continue;
            }
            if (body.length > MAX_FRAME_BYTES) {
                throw new Error("workload bridge frame exceeds maximum size");
            }
            const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
            parsed.push(JSON.parse(text));
        }
        return parsed;
    }

    hasPartial(): boolean {
        return this.partialBytes > 0;
    }

    private append(chunk: Buffer): void {
        if (chunk.length > Number.MAX_SAFE_INTEGER - this.partialBytes) {
            throw new Error("workload bridge frame size overflow");
        }
        const nextBytes = this.partialBytes + chunk.length;
        if (nextBytes > MAX_PARTIAL_FRAME_BYTES) {
            throw new Error("workload bridge frame exceeds maximum size");
        }
        if (chunk.length > 0) {
            this.parts.push(chunk);
            this.partialBytes = nextBytes;
        }
    }
}

function validateBridgeResponse(response: IncomingMessage): void {
    const status = response.statusCode ?? 0;
    if (status !== 200) {
        throw new Error(`workload bridge open failed with status ${status || "unknown"}`);
    }

    const contentType = headerValue(response.headers["content-type"])
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (contentType !== BRIDGE_CONTENT_TYPE) {
        throw new Error(`workload bridge returned unexpected content-type \`${contentType}\``);
    }
}

function headerValue(value: string | string[] | number | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? "";
    }
    return value === undefined ? "" : String(value);
}

function decodeBridgeResponse(value: unknown): BridgeResponse {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("workload bridge response must be an object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string") {
        throw new Error("workload bridge response is missing string id");
    }
    if ("error" in record) {
        return {
            id: record.id,
            error: record.error,
        };
    }
    if ("ok" in record) {
        return {
            id: record.id,
            ok: record.ok,
        };
    }
    throw new Error("workload bridge response must include ok or error");
}

function bridgeRequestOptions(
    bind: HostedBind,
    contentLength: number,
    agent: Agent,
    signal: AbortSignal,
): RequestOptions {
    const base: RequestOptions = {
        method: "POST",
        path: "/rpc",
        agent,
        signal,
        headers: {
            "content-type": BRIDGE_CONTENT_TYPE,
            "content-length": String(contentLength),
        },
    };
    if (bind.kind === "unix") {
        return {
            ...base,
            socketPath: bind.path,
            host: "localhost",
        };
    }
    if (bind.kind === "pipe") {
        return {
            ...base,
            socketPath: bind.name,
            host: "localhost",
        };
    }
    return {
        ...base,
        host: bind.host,
        port: bind.port,
    };
}

function formatRpcError(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return `workload bridge failed: ${JSON.stringify(error)}`;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
