import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { WorkloadBridgeClient } from "../src/rpc.ts";

const BRIDGE_CONTENT_TYPE = "application/x-capakit-workload-bridge-jsonl";

const servers: BridgeServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeBridgeServer(server)));
});

describe("WorkloadBridgeClient", () => {
    test("sends JSONL requests and resolves ok responses", async () => {
        const server = await listenBridge(async (request, response) => {
            expect(request.op).toBe("resolve_secret");
            expect(request.params).toEqual({ secret_key: "api_key" });
            writeBridgeResponse(response, { id: request.id, ok: { value: "secret-value" } });
        });
        const client = new WorkloadBridgeClient(server.bind);

        await expect(client.call("resolve_secret", {
            secret_key: "api_key",
        })).resolves.toEqual({ value: "secret-value" });

        await client.close();
    });

    test("rejects structured bridge errors", async () => {
        const wireError = {
            code: "Unavailable",
            message: "secret unavailable",
            retryable: true,
        };
        const server = await listenBridge(async (request, response) => {
            writeBridgeResponse(response, {
                id: request.id,
                error: wireError,
            });
        });
        const client = new WorkloadBridgeClient(server.bind);

        let thrown: unknown;
        try {
            await client.call("resolve_secret", {
                secret_key: "missing",
            });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/secret unavailable/);
        expect((thrown as Error).cause).toEqual(wireError);

        await client.close();
    });

    test("rejects non-bridge response statuses", async () => {
        const server = await listenRaw((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        const client = new WorkloadBridgeClient(server.bind);

        await expect(client.call("ping", {})).rejects.toThrow(/status 404/);
        await client.close();
    });

    test("rejects malformed response frames instead of leaving calls pending", async () => {
        const server = await listenRaw((_request, response) => {
            response.writeHead(200, { "content-type": BRIDGE_CONTENT_TYPE });
            response.end(encodeFrame({ ok: "missing-id" }));
        });
        const client = new WorkloadBridgeClient(server.bind);

        await expect(client.call("ping", {})).rejects.toThrow(/missing string id/);
        await client.close();
    });

    test("parses split response frames and waits for clean termination", async () => {
        let markFrameWritten: (() => void) | undefined;
        const frameWritten = new Promise<void>((resolve) => {
            markFrameWritten = resolve;
        });
        let releaseResponse: (() => void) | undefined;
        const responseReleased = new Promise<void>((resolve) => {
            releaseResponse = resolve;
        });
        const server = await listenRaw(async (request, response) => {
            const [frame] = decodeFrames(await readRequestBody(request)) as BridgeRequest[];
            const body = encodeFrame({ id: frame.id, ok: "pong" });
            response.writeHead(200, { "content-type": BRIDGE_CONTENT_TYPE });
            response.write(body.subarray(0, 5));
            response.write(body.subarray(5));
            markFrameWritten?.();
            await responseReleased;
            response.end();
        });
        const client = new WorkloadBridgeClient(server.bind);
        let settled = false;
        const call = client.call("ping", {}).finally(() => {
            settled = true;
        });

        await frameWritten;
        await Promise.resolve();
        expect(settled).toBe(false);
        releaseResponse?.();
        await expect(call).resolves.toBe("pong");
        await client.close();
    });

    test("rejects unexpected, duplicate, and incomplete response frames", async () => {
        for (const body of [
            encodeFrame({ id: "unexpected", ok: true }),
            Buffer.concat([
                encodeFrame({ id: "1", ok: true }),
                encodeFrame({ id: "1", ok: true }),
            ]),
            Buffer.from('{"id":"1","ok":true}', "utf8"),
        ]) {
            const server = await listenRaw((_request, response) => {
                response.writeHead(200, { "content-type": BRIDGE_CONTENT_TYPE });
                response.end(body);
            });
            const client = new WorkloadBridgeClient(server.bind);

            await expect(client.call("ping", {})).rejects.toThrow();
            await client.close();
        }
    });

    test("rejects invalid UTF-8 and oversized response frames", async () => {
        for (const body of [
            Buffer.from([0xff, 0x0a]),
            Buffer.concat([
                Buffer.alloc(4 * 1024 * 1024 + 2, 0x78),
                Buffer.from("\n"),
            ]),
        ]) {
            const server = await listenRaw((_request, response) => {
                response.writeHead(200, { "content-type": BRIDGE_CONTENT_TYPE });
                response.end(body);
            });
            const client = new WorkloadBridgeClient(server.bind);

            await expect(client.call("ping", {})).rejects.toThrow();
            await client.close();
        }
    });

    test("close aborts active calls", async () => {
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        const server = await listenRaw((_request, response) => {
            markStarted?.();
            return new Promise<void>((resolve) => response.once("close", resolve));
        });
        const client = new WorkloadBridgeClient(server.bind);
        const call = client.call("ping", {});
        const rejected = expect(call).rejects.toThrow();

        await started;
        await client.close();
        await rejected;
    });

    test("supports concurrent calls within one generation", async () => {
        const server = await listenBridge(async (request, response) => {
            writeBridgeResponse(response, { id: request.id, ok: request.op });
        });
        const client = new WorkloadBridgeClient(server.bind);

        await expect(
            Promise.all([
                client.call("first", {}),
                client.call("second", {}),
                client.call("third", {}),
            ]),
        ).resolves.toEqual(["first", "second", "third"]);
        await client.close();
    });

    test("reuses sockets within a generation and recreates them after close", async () => {
        const sockets = new Set<IncomingMessage["socket"]>();
        const server = await listenBridge(async (request, response) => {
            sockets.add(response.req.socket);
            writeBridgeResponse(response, { id: request.id, ok: "pong" });
        });
        const client = new WorkloadBridgeClient(server.bind);

        await client.call("ping", {});
        await client.call("ping", {});
        expect(sockets.size).toBe(1);

        await client.close();
        await client.call("ping", {});
        expect(sockets.size).toBe(2);
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
    server: Server;
};

async function listenBridge(
    handler: (request: BridgeRequest, response: ServerResponse) => Promise<void> | void,
): Promise<BridgeServer> {
    return listenRaw(async (request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/rpc");
        expect(headerValue(request.headers["content-type"])).toBe(BRIDGE_CONTENT_TYPE);

        const body = await readRequestBody(request);
        const frames = decodeFrames(body);
        for (const frame of frames) {
            await handler(frame as BridgeRequest, response);
        }
    });
}

async function listenRaw(
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<BridgeServer> {
    const server = createServer((request, response) => {
        void Promise.resolve(handler(request, response)).catch((error) => {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end(error instanceof Error ? error.message : String(error));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const bridge = {
        bind: `tcp:127.0.0.1:${address.port}`,
        server,
    };
    servers.push(bridge);
    return bridge;
}

async function closeBridgeServer(bridge: BridgeServer): Promise<void> {
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

function writeBridgeResponse(response: ServerResponse, value: unknown): void {
    response.writeHead(200, { "content-type": BRIDGE_CONTENT_TYPE });
    response.end(encodeFrame(value));
}

function encodeFrame(value: unknown): Buffer {
    return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function decodeFrames(buffer: Buffer): unknown[] {
    return buffer
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function headerValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? "";
    }
    return value ?? "";
}
