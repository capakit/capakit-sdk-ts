import { createServer } from "node:http2";
import type {
    Http2Server,
    ServerHttp2Session,
    ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { RunnerBridgeClient } from "../src/rpc.ts";

const BRIDGE_CONTENT_TYPE = "application/x-capakit-runner-bridge-json-framed";

const servers: BridgeServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeBridgeServer(server)));
});

describe("RunnerBridgeClient", () => {
    test("sends length-prefixed requests and resolves ok responses", async () => {
        const server = await listenBridge(async (request, stream) => {
            expect(request.op).toBe("resolve_secret");
            expect(request.params).toEqual({ secret_mid: "secret:api_key" });
            stream.write(encodeFrame({ id: request.id, ok: { value: "secret-value" } }));
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("resolve_secret", {
            secret_mid: "secret:api_key",
        })).resolves.toEqual({ value: "secret-value" });

        await client.close();
    });

    test("rejects structured bridge errors", async () => {
        const server = await listenBridge(async (request, stream) => {
            stream.write(encodeFrame({
                id: request.id,
                error: {
                    code: "Unavailable",
                    message: "secret unavailable",
                    retryable: true,
                },
            }));
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("resolve_secret", {
            secret_mid: "secret:missing",
        })).rejects.toThrow(/secret unavailable/);

        await client.close();
    });

    test("rejects non-bridge response statuses", async () => {
        const server = await listenRaw((stream) => {
            stream.respond({ ":status": 404 });
            stream.end();
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("ping", {})).rejects.toThrow(/status 404/);
        await client.close();
    });

    test("rejects malformed response frames instead of leaving calls pending", async () => {
        const server = await listenRaw((stream) => {
            stream.respond({
                ":status": 200,
                "content-type": BRIDGE_CONTENT_TYPE,
            });
            stream.write(encodeFrame({ ok: "missing-id" }));
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("ping", {})).rejects.toThrow(/missing string id/);
        await client.close();
    });
});

type BridgeRequest = {
    id: string;
    op: string;
    params?: unknown;
};

type BridgeServer = {
    bind: string;
    server: Http2Server;
    sessions: Set<ServerHttp2Session>;
};

async function listenBridge(
    handler: (request: BridgeRequest, stream: ServerHttp2Stream) => Promise<void> | void,
): Promise<BridgeServer> {
    return listenRaw((stream) => {
        stream.respond({
            ":status": 200,
            "content-type": BRIDGE_CONTENT_TYPE,
        });
        let buffer = Buffer.alloc(0);
        stream.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const decoded = decodeFrames(buffer);
            buffer = decoded.rest;
            for (const request of decoded.frames) {
                void handler(request as BridgeRequest, stream);
            }
        });
    });
}

async function listenRaw(
    handler: (stream: ServerHttp2Stream) => void,
): Promise<BridgeServer> {
    const server = createServer();
    server.on("stream", handler);
    const sessions = new Set<ServerHttp2Session>();
    server.on("session", (session) => {
        sessions.add(session);
        session.on("close", () => sessions.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const bridge = {
        bind: `tcp:127.0.0.1:${address.port}`,
        server,
        sessions,
    };
    servers.push(bridge);
    return bridge;
}

async function closeBridgeServer(bridge: BridgeServer): Promise<void> {
    for (const session of bridge.sessions) {
        session.destroy();
    }
    await new Promise<void>((resolve, reject) => {
        bridge.server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function encodeFrame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

function decodeFrames(buffer: Buffer): { frames: unknown[]; rest: Buffer } {
    const frames: unknown[] = [];
    let offset = 0;
    while (buffer.length - offset >= 4) {
        const bodyLength = buffer.readUInt32BE(offset);
        const end = offset + 4 + bodyLength;
        if (buffer.length < end) {
            break;
        }
        frames.push(JSON.parse(buffer.subarray(offset + 4, end).toString("utf8")));
        offset = end;
    }
    return {
        frames,
        rest: buffer.subarray(offset),
    };
}
