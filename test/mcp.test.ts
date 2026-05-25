import { describe, expect, test } from "vitest";

import { HostedMcpBridge } from "../src/mcp.ts";

describe("HostedMcpBridge", () => {
    test("keeps ndjson response for legacy hosted MCP clients", async () => {
        const response = await bridgeResponse({
            accept: null,
            contentType: "application/x-ndjson",
            body: `${JSON.stringify(requestMessage(1))}\n`,
        });

        expect(response.headers.get("content-type")).toBe("application/x-ndjson");
        expect(parseNdjson(await response.text())[0]).toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603 },
        });
    });

    test("accepts application/json requests and returns application/json", async () => {
        const response = await bridgeResponse({
            accept: "application/json",
            contentType: "application/json",
            body: JSON.stringify(requestMessage(2)),
        });

        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await response.json()).toMatchObject({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32603 },
        });
    });

    test("returns server-sent events when streamable HTTP clients accept event streams", async () => {
        const response = await bridgeResponse({
            accept: "text/event-stream, application/json",
            contentType: "application/json",
            body: JSON.stringify(requestMessage(3)),
        });

        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
        expect(parseSse(await response.text())[0]).toMatchObject({
            jsonrpc: "2.0",
            id: 3,
            error: { code: -32603 },
        });
    });
});

async function bridgeResponse(params: {
    accept: string | null;
    contentType: string;
    body: string;
}): Promise<Response> {
    const headers = new Headers({ "content-type": params.contentType });
    if (params.accept) {
        headers.set("accept", params.accept);
    }
    return await new HostedMcpBridge().handleRequest(
        new Request("http://capakit.local/mcp", {
            method: "POST",
            headers,
            body: params.body,
        }),
    );
}

function requestMessage(id: number) {
    return {
        jsonrpc: "2.0" as const,
        id,
        method: "tools/call",
        params: {
            name: "missing-tool",
            arguments: {},
        },
    };
}

function parseNdjson(raw: string): unknown[] {
    return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

function parseSse(raw: string): unknown[] {
    return raw
        .split("\n\n")
        .filter((event) => event.trim().length > 0)
        .map((event) => {
            const data = event
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice("data: ".length);
            expect(data).toBeTruthy();
            return JSON.parse(data!);
        });
}
