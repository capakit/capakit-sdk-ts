import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

import {
    clientAuthority,
    closeServer,
    createHostedFetch,
    createHostedServer,
    listen,
    parseBind,
} from "../src/transport.ts";

const FRAMED_H1_CONTENT_TYPE = "application/x-capakit-body-frame-jsonl";

describe("parseBind", () => {
    test("parses TCP binds", () => {
        expect(parseBind("tcp:127.0.0.1:4100")).toEqual({
            kind: "tcp",
            host: "127.0.0.1",
            port: 4100,
        });
    });

    test("parses Unix socket binds", () => {
        expect(parseBind("unix:/tmp/capakit.sock")).toEqual({
            kind: "unix",
            path: "/tmp/capakit.sock",
        });
    });

    test("parses pipe binds", () => {
        expect(parseBind("pipe:capakit-runner")).toEqual({
            kind: "pipe",
            name: "capakit-runner",
        });
    });

    test("rejects malformed TCP ports", () => {
        expect(() => parseBind("tcp:127.0.0.1:not-a-port")).toThrow(/invalid tcp port/);
    });
});

describe("clientAuthority", () => {
    test("uses concrete authority for TCP binds", () => {
        expect(clientAuthority({
            kind: "tcp",
            host: "127.0.0.1",
            port: 4100,
        })).toBe("http://127.0.0.1:4100");
    });

    test("uses localhost authority for stream-backed binds", () => {
        expect(clientAuthority({
            kind: "unix",
            path: "/tmp/capakit.sock",
        })).toBe("http://localhost");
    });
});

describe("createHostedFetch", () => {
    test("can issue repeated requests to the same bind", async () => {
        const server = createHostedServer(async (request) => {
            const url = new URL(request.url);
            return Response.json({
                method: request.method,
                path: `${url.pathname}${url.search}`,
            });
        });
        await listen(server, { kind: "tcp", host: "127.0.0.1", port: 0 });

        try {
            const address = server.address();
            if (address === null || typeof address === "string") {
                throw new Error("expected TCP test server address");
            }

            const hostedFetch = createHostedFetch({
                kind: "tcp",
                host: "127.0.0.1",
                port: address.port,
            });

            const first = await hostedFetch("http://capakit.local/first");
            const second = await hostedFetch("http://capakit.local/second?x=1");

            await expect(first.json()).resolves.toEqual({
                method: "GET",
                path: "/first",
            });
            await expect(second.json()).resolves.toEqual({
                method: "GET",
                path: "/second?x=1",
            });
        } finally {
            await closeServer(server);
        }
    });

    test("preserves method, headers, body, status, and response headers", async () => {
        const server = createHostedServer(async (request) => {
            expect(request.method).toBe("POST");
            expect(request.headers.get("x-test-header")).toBe("hello");
            await expect(request.text()).resolves.toBe("request body");
            return new Response("response body", {
                status: 202,
                headers: {
                    "x-response-header": "world",
                },
            });
        });
        await listen(server, { kind: "tcp", host: "127.0.0.1", port: 0 });

        try {
            const hostedFetch = createHostedFetch(tcpBind(server));
            const response = await hostedFetch("http://capakit.local/echo", {
                method: "POST",
                headers: {
                    "x-test-header": "hello",
                },
                body: "request body",
            });

            expect(response.status).toBe(202);
            expect(response.headers.get("x-response-header")).toBe("world");
            await expect(response.text()).resolves.toBe("response body");
        } finally {
            await closeServer(server);
        }
    });

    test("rejects structured end errors from the runner bridge", async () => {
        const server = await listenRawFramed((_request, response) => {
            writeFramedResponse(response, [
                {
                    type: "end",
                    trailers: null,
                    error: {
                        code: "Unavailable",
                        message: "bridge unavailable",
                        options: { retryable: true },
                    },
                },
            ]);
        });

        try {
            const hostedFetch = createHostedFetch(tcpBind(server));
            await expect(hostedFetch("http://capakit.local/fail")).rejects.toThrow(/bridge unavailable/);
        } finally {
            await closeServer(server);
        }
    });

    test("rejects malformed runner bridge frames", async () => {
        const server = await listenRawFramed((_request, response) => {
            writeFramedResponse(response, [
                {
                    type: "message",
                    payload: "not valid over H1",
                },
            ]);
        });

        try {
            const hostedFetch = createHostedFetch(tcpBind(server));
            await expect(hostedFetch("http://capakit.local/malformed")).rejects.toThrow(/unsupported type `message`/);
        } finally {
            await closeServer(server);
        }
    });

    test("rejects aborted in-flight requests", async () => {
        const server = await listenRawFramed((request, _response) => {
            request.resume();
        });
        const controller = new AbortController();

        try {
            const hostedFetch = createHostedFetch(tcpBind(server));
            const pending = hostedFetch("http://capakit.local/slow", {
                signal: controller.signal,
            });
            controller.abort();

            await expect(pending).rejects.toThrow(/aborted/);
        } finally {
            await closeServer(server);
        }
    });
});

function tcpBind(server: Server) {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("expected TCP test server address");
    }
    return {
        kind: "tcp" as const,
        host: "127.0.0.1",
        port: (address as AddressInfo).port,
    };
}

async function listenRawFramed(
    handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<Server> {
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
    return server;
}

function writeFramedResponse(response: ServerResponse, frames: unknown[]): void {
    response.writeHead(200, {
        "content-type": FRAMED_H1_CONTENT_TYPE,
    });
    response.end(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
}
