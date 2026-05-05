import { describe, expect, test } from "vitest";

import {
    clientAuthority,
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
