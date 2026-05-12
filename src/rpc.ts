import { request as requestHttp } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";

import { parseBind } from "./transport.ts";
import type { HostedBind } from "./public-types.ts";

const BRIDGE_CONTENT_TYPE = "application/x-capakit-runner-bridge-jsonl";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

type BridgeResponse = { id: string; ok: unknown } | { id: string; error: unknown };

export class RunnerBridgeClient {
    private nextId = 1;
    private readonly bind: HostedBind;

    constructor(value: string) {
        this.bind = parseBind(value);
    }

    async call<Result>(op: string, params: unknown): Promise<Result> {
        const id = String(this.nextId++);
        const response = await this.send(id, { id, op, params });
        if ("error" in response) {
            throw new Error(formatRpcError(response.error));
        }
        return response.ok as Result;
    }

    async close(): Promise<void> {}

    private async send(id: string, request: unknown): Promise<BridgeResponse> {
        const frame = encodeJsonLine(request);
        return await new Promise<BridgeResponse>((resolve, reject) => {
            const parser = new JsonLineParser();
            let settled = false;
            const settle = (fn: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                fn();
            };
            const req = requestHttp(bridgeRequestOptions(this.bind, frame.length), (response) => {
                try {
                    validateBridgeResponse(response);
                } catch (error) {
                    settle(() =>
                        reject(error instanceof Error ? error : new Error(String(error))),
                    );
                    response.destroy();
                    req.destroy();
                    return;
                }
                response.on("data", (chunk: Buffer) => {
                    try {
                        for (const item of parser.feed(chunk)) {
                            const decoded = decodeBridgeResponse(item);
                            if (decoded.id === id) {
                                settle(() => resolve(decoded));
                            }
                        }
                    } catch (error) {
                        settle(() =>
                            reject(error instanceof Error ? error : new Error(String(error))),
                        );
                    }
                });
                response.on("error", (error) => settle(() => reject(error)));
                response.on("end", () => {
                    settle(() =>
                        reject(
                            new Error(
                                "runner bridge response ended without a matching response",
                            ),
                        ),
                    );
                });
            });
            req.on("error", (error) => settle(() => reject(error)));
            req.on("socket", (socket) => {
                socket.setNoDelay?.(true);
            });
            req.end(frame);
        });
    }
}

function encodeJsonLine(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.length > MAX_FRAME_BYTES) {
        throw new Error("runner bridge request frame exceeds maximum size");
    }
    return Buffer.concat([body, Buffer.from("\n")]);
}

class JsonLineParser {
    private buffer = Buffer.alloc(0);

    feed(chunk: Buffer): unknown[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > MAX_BUFFER_BYTES) {
            this.buffer = Buffer.alloc(0);
            throw new Error("runner bridge frame buffer limit exceeded");
        }

        const parsed: unknown[] = [];
        while (true) {
            const lineEnd = this.buffer.indexOf(0x0a);
            if (lineEnd < 0) {
                break;
            }
            let body = this.buffer.subarray(0, lineEnd);
            this.buffer = this.buffer.subarray(lineEnd + 1);
            if (body.at(-1) === 0x0d) {
                body = body.subarray(0, body.length - 1);
            }
            if (body.length === 0) {
                continue;
            }
            const bodyLength = body.length;
            if (bodyLength > MAX_FRAME_BYTES) {
                this.buffer = Buffer.alloc(0);
                throw new Error("runner bridge frame exceeds maximum size");
            }
            parsed.push(JSON.parse(body.toString("utf8")));
        }
        return parsed;
    }
}

function validateBridgeResponse(response: IncomingMessage): void {
    const status = response.statusCode ?? 0;
    if (status !== 200) {
        throw new Error(`runner bridge open failed with status ${status || "unknown"}`);
    }

    const contentType = headerValue(response.headers["content-type"])
        .split(";")[0]
        .trim()
        .toLowerCase();
    if (contentType !== BRIDGE_CONTENT_TYPE) {
        throw new Error(`runner bridge returned unexpected content-type \`${contentType}\``);
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
        throw new Error("runner bridge response must be an object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string") {
        throw new Error("runner bridge response is missing string id");
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
    throw new Error("runner bridge response must include ok or error");
}

function bridgeRequestOptions(bind: HostedBind, contentLength: number): RequestOptions {
    const base: RequestOptions = {
        method: "POST",
        path: "/rpc",
        headers: {
            "content-type": BRIDGE_CONTENT_TYPE,
            "content-length": String(contentLength),
            "connection": "close",
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
    return `runner bridge failed: ${JSON.stringify(error)}`;
}
