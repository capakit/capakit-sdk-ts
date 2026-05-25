import { describe, expect, test } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";

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

    test("honors response content negotiation order", async () => {
        const response = await bridgeResponse({
            accept: "application/json, text/event-stream",
            contentType: "application/json",
            body: JSON.stringify(requestMessage(4)),
        });

        expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(await response.json()).toMatchObject({
            jsonrpc: "2.0",
            id: 4,
            error: { code: -32603 },
        });
    });

    test("accepts notification-only requests without a response stream", async () => {
        const response = await bridgeResponse({
            accept: "text/event-stream, application/json",
            contentType: "application/json",
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
            }),
        });

        expect(response.status).toBe(202);
        expect(await response.text()).toBe("");
    });

    test("streams server-to-client requests before final tool responses", async () => {
        const bridge = new HostedMcpBridge();
        const server = new McpServer({ name: "bidi-test", version: "0.0.0" });
        server.registerTool(
            "client-roots",
            { inputSchema: {} },
            async (_args, extra) => {
                const roots = await extra.sendRequest(
                    { method: "roots/list", params: {} },
                    ListRootsResultSchema,
                );
                return {
                    content: [{ type: "text", text: JSON.stringify(roots) }],
                    structuredContent: roots,
                };
            },
        );
        bridge.mount(server);
        await bridge.start();

        await bridgeJson(bridge, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: { roots: {} },
                clientInfo: { name: "test-client", version: "0.0.0" },
            },
        });
        await bridgeJson(bridge, {
            jsonrpc: "2.0",
            method: "notifications/initialized",
        });

        const response = await bridgeJson(bridge, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "client-roots", arguments: {} },
        }, "text/event-stream, application/json");
        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

        const stream = sseMessageStream(response);
        const rootsRequest = await stream.next();
        expect(rootsRequest.value).toMatchObject({
            jsonrpc: "2.0",
            method: "roots/list",
        });

        await bridgeJson(bridge, {
            jsonrpc: "2.0",
            id: rootsRequest.value.id,
            result: {
                roots: [{ uri: "file:///tmp/test-root", name: "test-root" }],
            },
        });

        const toolResponse = await stream.next();
        expect(toolResponse.value).toMatchObject({
            jsonrpc: "2.0",
            id: 2,
            result: {
                structuredContent: {
                    roots: [{ uri: "file:///tmp/test-root", name: "test-root" }],
                },
            },
        });
        expect((await stream.next()).done).toBe(true);
    });
});

async function bridgeJson(
    bridge: HostedMcpBridge,
    message: unknown,
    accept = "application/json",
): Promise<Response> {
    return await bridge.handleRequest(
        new Request("http://capakit.local/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept,
            },
            body: JSON.stringify(message),
        }),
    );
}

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

async function* sseMessageStream(response: Response): AsyncGenerator<any> {
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const marker = buffer.indexOf("\n\n");
        if (marker >= 0) {
            const event = buffer.slice(0, marker);
            buffer = buffer.slice(marker + 2);
            const data = event
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice("data: ".length);
            if (data) {
                yield JSON.parse(data);
            }
            continue;
        }

        const { done, value } = await reader!.read();
        if (done) {
            return;
        }
        buffer += decoder.decode(value, { stream: true });
    }
}
