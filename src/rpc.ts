import { connect as connectHttp2 } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";

import {
    clientAuthority,
    clientConnectOptions,
    parseBind,
} from "./transport.ts";
import type { HostedBind } from "./public-types.ts";

const BRIDGE_CONTENT_TYPE = "application/x-capakit-runner-bridge-json-framed";

type BridgeResponse = { id: string; ok: unknown } | { id: string; error: unknown };

type PendingCall = {
    resolve: (response: BridgeResponse) => void;
    reject: (error: Error) => void;
};

export class RunnerBridgeClient {
    private nextId = 1;
    private readonly bind: HostedBind;
    private session: ClientHttp2Session | null = null;
    private stream: ClientHttp2Stream | null = null;
    private pending = new Map<string, PendingCall>();
    private parser = new LengthPrefixedJsonParser();
    private opening: Promise<void> | null = null;

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

    async close(): Promise<void> {
        this.failPending(new Error("runner bridge client closed"));
        this.stream?.end();
        this.session?.close();
        this.stream = null;
        this.session = null;
        this.opening = null;
    }

    private async send(id: string, request: unknown): Promise<BridgeResponse> {
        await this.open();
        const stream = this.stream;
        if (!stream || stream.closed || stream.destroyed) {
            throw new Error("runner bridge stream is closed");
        }

        const response = new Promise<BridgeResponse>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        try {
            stream.write(encodeLengthPrefixedJsonFrame(request));
        } catch (error) {
            this.pending.delete(id);
            throw error;
        }
        return await response;
    }

    private async open(): Promise<void> {
        if (this.stream && !this.stream.closed && !this.stream.destroyed) {
            return;
        }
        if (this.opening) {
            return await this.opening;
        }
        this.opening = this.openFresh();
        try {
            await this.opening;
        } finally {
            this.opening = null;
        }
    }

    private async openFresh(): Promise<void> {
        const session = connectHttp2(
            clientAuthority(this.bind),
            clientConnectOptions(this.bind),
        );
        const stream = session.request({
            ":method": "POST",
            ":path": "/rpc",
            "content-type": BRIDGE_CONTENT_TYPE,
        });

        this.session = session;
        this.stream = stream;
        this.parser = new LengthPrefixedJsonParser();

        const fail = (error: Error) => {
            this.failPending(error);
            this.stream = null;
            this.session = null;
        };
        session.on("error", fail);
        stream.on("error", fail);
        stream.on("close", () => fail(new Error("runner bridge stream closed")));
        stream.on("data", (chunk: Buffer) => {
            try {
                for (const response of this.parser.feed(chunk)) {
                    this.resolvePending(response as BridgeResponse);
                }
            } catch (error) {
                this.failPending(error instanceof Error ? error : new Error(String(error)));
                stream.close();
            }
        });

        await new Promise<void>((resolve, reject) => {
            stream.once("response", () => resolve());
            stream.once("error", reject);
            session.once("error", reject);
        });
    }

    private resolvePending(response: BridgeResponse): void {
        const pending = this.pending.get(response.id);
        if (!pending) {
            return;
        }
        this.pending.delete(response.id);
        pending.resolve(response);
    }

    private failPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}

function encodeLengthPrefixedJsonFrame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

class LengthPrefixedJsonParser {
    private buffer = Buffer.alloc(0);

    feed(chunk: Buffer): unknown[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const parsed: unknown[] = [];
        while (this.buffer.length >= 4) {
            const bodyLength = this.buffer.readUInt32BE(0);
            const frameLength = 4 + bodyLength;
            if (this.buffer.length < frameLength) {
                break;
            }
            const body = this.buffer.subarray(4, frameLength);
            this.buffer = this.buffer.subarray(frameLength);
            parsed.push(JSON.parse(body.toString("utf8")));
        }
        return parsed;
    }
}

function formatRpcError(error: unknown): string {
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message: unknown }).message);
    }
    return `runner bridge failed: ${JSON.stringify(error)}`;
}
