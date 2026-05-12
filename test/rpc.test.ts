import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { RunnerBridgeClient } from "../src/rpc.ts";

const BRIDGE_CONTENT_TYPE = "application/x-capakit-runner-bridge-jsonl";

const servers: BridgeServer[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeBridgeServer(server)));
});

describe("RunnerBridgeClient", () => {
    test("sends JSONL requests and resolves ok responses", async () => {
        const server = await listenBridge(async (request, response) => {
            expect(request.op).toBe("resolve_secret");
            expect(request.params).toEqual({ secret_mid: "secret:api_key" });
            writeBridgeResponse(response, { id: request.id, ok: { value: "secret-value" } });
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("resolve_secret", {
            secret_mid: "secret:api_key",
        })).resolves.toEqual({ value: "secret-value" });

        await client.close();
    });

    test("rejects structured bridge errors", async () => {
        const server = await listenBridge(async (request, response) => {
            writeBridgeResponse(response, {
                id: request.id,
                error: {
                    code: "Unavailable",
                    message: "secret unavailable",
                    retryable: true,
                },
            });
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("resolve_secret", {
            secret_mid: "secret:missing",
        })).rejects.toThrow(/secret unavailable/);

        await client.close();
    });

    test("rejects non-bridge response statuses", async () => {
        const server = await listenRaw((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        const client = new RunnerBridgeClient(server.bind);

        await expect(client.call("ping", {})).rejects.toThrow(/status 404/);
        await client.close();
    });

    test("rejects malformed response frames instead of leaving calls pending", async () => {
        const server = await listenRaw((_request, response) => {
            response.writeHead(200, { "content-type": BRIDGE_CONTENT_TYPE });
            response.end(encodeFrame({ ok: "missing-id" }));
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
