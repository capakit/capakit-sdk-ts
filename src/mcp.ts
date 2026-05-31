import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { endpointPath as normalizeEndpointPath } from "./ids.ts";
import { createHostedFetch } from "./transport.ts";
import type {
    ClientOptions,
    EndpointPath,
    HostedBind,
    RunnerSdk,
    RunnerSdkMount,
    WorkloadMid,
} from "./public-types.ts";

const MCP_STREAM_CONTENT_TYPE = "application/x-ndjson";
const MCP_JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MCP_SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

export type McpClient = Client;
export type McpSessionId = string;

export type McpProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<McpClient>;
    mount(options: McpMountOptions): RunnerSdkMount;
    close(): Promise<void>;
};

export type McpMountOptions = {
    endpoint: EndpointPath;
    server: McpServer;
};

export type MountMcpOptions = {
    endpoint: string | EndpointPath;
    server: McpServer;
};

export function mountMcp(sdk: RunnerSdk, options: MountMcpOptions): void {
    sdk.mount(mcpProvider(sdk).mount({
        endpoint: typeof options.endpoint === "string"
            ? normalizeEndpointPath(options.endpoint)
            : options.endpoint,
        server: options.server,
    }));
}

export function mcpProvider(sdk: RunnerSdk): McpProvider {
    const clients = new Set<Client>();
    return {
        async createClient(workloadMid, endpointPath, options = {}) {
            const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
            const client = new Client({
                name: "@capakit/sdk",
                version: "0.0.0",
            });
            const transport = new HostedMcpClientTransport(
                endpoint.bind,
                endpoint.endpoint,
            );
            await client.connect(transport, { timeout: options.timeoutMs });
            clients.add(client);
            return client;
        },
        mount(options) {
            const bridge = new HostedMcpBridge();
            bridge.mount(options.server);
            return {
                protocol: "mcp",
                endpoint: options.endpoint,
                start: () => bridge.start(),
                stop: () => bridge.stop(),
                handler: (request) => bridge.handleRequest(request),
            };
        },
        async close() {
            const active = Array.from(clients);
            clients.clear();
            await Promise.all(active.map((client) => client.close()));
        },
    };
}

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
        const responseFormat = negotiateResponseFormat(request);
        const messages = parseJsonRpcMessages(
            await request.text(),
            request.headers.get("content-type"),
        );

        if (responseFormat === "sse" && messages.some(hasRequestId)) {
            return this.handleStreamingRequest(messages, responseFormat);
        }

        const output: JSONRPCMessage[] = [];
        const writeMessage = async (message: JSONRPCMessage) => {
            output.push(message);
        };

        for (const message of messages) {
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

        if (output.length === 0) {
            return new Response(null, { status: 202 });
        }

        return new Response(encodeJsonRpcMessages(output, responseFormat), {
            status: 200,
            headers: { "content-type": responseContentType(responseFormat) },
        });
    }

    private handleStreamingRequest(
        messages: JSONRPCMessage[],
        responseFormat: McpResponseFormat,
    ): Response {
        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                void this.writeStreamingRequest(messages, responseFormat, controller);
            },
        });
        return new Response(stream, {
            status: 200,
            headers: { "content-type": responseContentType(responseFormat) },
        });
    }

    private async writeStreamingRequest(
        messages: JSONRPCMessage[],
        responseFormat: McpResponseFormat,
        controller: ReadableStreamDefaultController<Uint8Array>,
    ): Promise<void> {
        const writeMessage = async (message: JSONRPCMessage) => {
            controller.enqueue(encodeUtf8(encodeJsonRpcMessages([message], responseFormat)));
        };

        try {
            for (const message of messages) {
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
            controller.close();
        } catch (error) {
            controller.error(error);
        }
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

type McpResponseFormat = "json" | "ndjson" | "sse";

function parseJsonRpcMessages(raw: string, contentType: string | null): JSONRPCMessage[] {
    if (isJsonContentType(contentType)) {
        const parsed = JSON.parse(raw) as JSONRPCMessage | JSONRPCMessage[];
        return Array.isArray(parsed) ? parsed : [parsed];
    }
    return parseJsonRpcLines(raw);
}

function negotiateResponseFormat(request: Request): McpResponseFormat {
    const accept = request.headers.get("accept") ?? "";
    for (const entry of acceptedMediaTypes(accept)) {
        if (entry === "text/event-stream") {
            return "sse";
        }
        if (entry === "application/json") {
            return "json";
        }
    }
    return "ndjson";
}

function encodeJsonRpcMessages(
    messages: JSONRPCMessage[],
    format: McpResponseFormat,
): string {
    if (format === "json") {
        if (messages.length === 1) {
            return JSON.stringify(messages[0]);
        }
        return JSON.stringify(messages);
    }
    if (format === "sse") {
        return messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
    }
    return messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
}

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function responseContentType(format: McpResponseFormat): string {
    if (format === "json") {
        return MCP_JSON_CONTENT_TYPE;
    }
    if (format === "sse") {
        return MCP_SSE_CONTENT_TYPE;
    }
    return MCP_STREAM_CONTENT_TYPE;
}

function isJsonContentType(contentType: string | null): boolean {
    return mediaType(contentType) === "application/json";
}

function acceptedMediaTypes(accept: string): string[] {
    return accept
        .split(",")
        .map((entry) => mediaType(entry))
        .filter((entry) => entry.length > 0);
}

function mediaType(value: string | null): string {
    return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}
