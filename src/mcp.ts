import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { createHostedFetch } from "./transport.ts";
import type { EndpointPath, HostedBind, McpSessionId } from "./public-types.ts";

const MCP_STREAM_CONTENT_TYPE = "application/x-ndjson";

type PendingResponse = {
    resolve: (response: JSONRPCMessage) => void;
    reject: (error: Error) => void;
};

type OutboundMessageHandler = (message: JSONRPCMessage) => Promise<void> | void;

export class HostedMcpClientTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sessionId?: McpSessionId;

    private started = false;
    private closed = false;
    private readonly hostedFetch: typeof fetch;

    constructor(
        bind: HostedBind,
        private readonly requestPath: EndpointPath,
    ) {
        this.hostedFetch = createHostedFetch(bind);
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.closed = false;
    }

    async send(message: JSONRPCMessage): Promise<void> {
        await this.start();
        if (this.closed) {
            throw new Error("hosted MCP client transport is closed");
        }
        try {
            const response = await this.hostedFetch(`http://capakit.local${this.requestPath}`, {
                method: "POST",
                headers: { "content-type": MCP_STREAM_CONTENT_TYPE },
                body: `${JSON.stringify(message)}\n`,
            });
            const text = await response.text();
            for (const item of parseJsonRpcLines(text)) {
                this.onmessage?.(item);
            }
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.onerror?.(normalized);
            throw normalized;
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        this.onclose?.();
    }
}

export class HostedMcpBridge {
    private mountedServer: McpServer | null = null;
    private clientTransport: InMemoryTransport | null = null;
    private readonly pendingResponses = new Map<string, PendingResponse>();
    private exchangeQueue: Promise<void> = Promise.resolve();
    private outboundMessageHandler: OutboundMessageHandler | null = null;

    mount(server: McpServer): void {
        if (this.mountedServer) {
            throw new Error("runner SDK already mounted an MCP server");
        }
        this.mountedServer = server;
    }

    async start(): Promise<void> {
        const server = this.mountedServer;
        if (!server) {
            throw new Error("runner SDK requires an MCP server mount before start");
        }
        if (this.clientTransport) {
            return;
        }

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        clientTransport.onmessage = (message) => {
            void this.handleClientMessage(message);
        };
        clientTransport.onerror = (error) => {
            this.rejectAllPending(error);
        };
        clientTransport.onclose = () => {
            this.rejectAllPending(new Error("runner MCP bridge closed"));
        };

        await clientTransport.start();
        await server.connect(serverTransport);
        this.clientTransport = clientTransport;
    }

    async stop(): Promise<void> {
        const clientTransport = this.clientTransport;
        this.clientTransport = null;
        this.rejectAllPending(new Error("runner MCP bridge stopped"));
        if (this.mountedServer?.isConnected()) {
            await this.mountedServer.close();
        }
        if (clientTransport) {
            await clientTransport.close();
        }
    }

    async handleRequest(request: Request): Promise<Response> {
        let output = "";
        const writeMessage = async (message: JSONRPCMessage) => {
            output += `${JSON.stringify(message)}\n`;
        };

        for (const message of parseJsonRpcLines(await request.text())) {
            try {
                const response = await this.handleMessage(message, writeMessage);
                if (response) {
                    await writeMessage(response);
                }
            } catch (error) {
                if (hasRequestId(message)) {
                    await writeMessage(
                        encodeRpcError(
                            message.id,
                            -32603,
                            error instanceof Error ? error.message : "internal error",
                        ),
                    );
                }
            }
        }

        return new Response(output, {
            status: 200,
            headers: { "content-type": MCP_STREAM_CONTENT_TYPE },
        });
    }

    async handleMessage(
        message: JSONRPCMessage,
        outboundHandler: OutboundMessageHandler,
    ): Promise<JSONRPCMessage | null> {
        const transport = this.clientTransport;
        if (!transport) {
            throw new Error("runner MCP bridge is not started");
        }

        if (isResponseMessage(message)) {
            await transport.send(message);
            return null;
        }

        if (!hasRequestId(message)) {
            await transport.send(message);
            return null;
        }

        return await this.enqueueExchange(async () => {
            return await this.withOutboundMessageHandler(outboundHandler, async () => {
                const key = responseKey(message.id);
                return await new Promise<JSONRPCMessage>((resolve, reject) => {
                    this.pendingResponses.set(key, { resolve, reject });
                    void transport.send(message).catch((error) => {
                        this.pendingResponses.delete(key);
                        reject(error instanceof Error ? error : new Error(String(error)));
                    });
                });
            });
        });
    }

    private async enqueueExchange<T>(work: () => Promise<T>): Promise<T> {
        const run = this.exchangeQueue.then(work, work);
        this.exchangeQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    private async withOutboundMessageHandler<T>(
        handler: OutboundMessageHandler,
        work: () => Promise<T>,
    ): Promise<T> {
        const previous = this.outboundMessageHandler;
        this.outboundMessageHandler = handler;
        try {
            return await work();
        } finally {
            if (this.outboundMessageHandler === handler) {
                this.outboundMessageHandler = previous;
            }
        }
    }

    private async handleClientMessage(message: JSONRPCMessage): Promise<void> {
        if (isResponseMessage(message)) {
            const key = responseKey(message.id);
            const pending = this.pendingResponses.get(key);
            if (!pending) {
                return;
            }
            this.pendingResponses.delete(key);
            pending.resolve(message);
            return;
        }

        if (!this.outboundMessageHandler) {
            return;
        }

        await this.outboundMessageHandler(message);
    }

    private rejectAllPending(error: Error): void {
        const pending = Array.from(this.pendingResponses.values());
        this.pendingResponses.clear();
        for (const entry of pending) {
            entry.reject(error);
        }
    }
}

function hasRequestId(
    message: JSONRPCMessage,
): message is JSONRPCMessage & { id: number | string | null } {
    return typeof message === "object" && message !== null && "id" in message;
}

function isResponseMessage(
    message: JSONRPCMessage,
): message is JSONRPCMessage & { id: number | string | null } {
    return hasRequestId(message) && ("result" in message || "error" in message);
}

function responseKey(id: number | string | null): string {
    if (id === null) {
        return "null";
    }
    return `${typeof id}:${id}`;
}

function encodeRpcError(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
) {
    return {
        jsonrpc: "2.0" as const,
        id: id ?? undefined,
        error: {
            code,
            message,
            data,
        },
    };
}

function parseJsonRpcLines(raw: string): JSONRPCMessage[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as JSONRPCMessage);
}
