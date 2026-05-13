import { describe, expect, test } from "vitest";

import {
    clientAuthority,
    closeServer,
    createHostedFetch,
    createHostedServer,
    listen,
    parseBind,
} from "../src/transport.ts";

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
});
