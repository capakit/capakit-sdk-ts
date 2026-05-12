import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { connect as connectHttp2 } from "node:http2";
import type {
    ClientHttp2Session,
    ClientHttp2Stream,
    IncomingHttpHeaders,
    ServerHttp2Stream,
} from "node:http2";

import {
    clientAuthority,
    clientConnectOptions,
} from "./transport.ts";
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

    private session: ClientHttp2Session | null = null;
    private stream: ClientHttp2Stream | null = null;
    private started = false;
    private closed = false;

    constructor(
        private readonly bind: HostedBind,
        private readonly requestPath: EndpointPath,
    ) {}

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.closed = false;
        const session = connectHttp2(
            clientAuthority(this.bind),
            clientConnectOptions(this.bind),
        );
        this.session = session;
        session.on("error", (error) => {
            this.onerror?.(error);
        });
        session.on("close", () => {
            this.session = null;
            this.stream = null;
            if (!this.closed) {
                this.onclose?.();
            }
        });

        const stream = session.request({
            ":method": "POST",
            ":path": this.requestPath,
            "content-type": MCP_STREAM_CONTENT_TYPE,
        });
        this.stream = stream;
        stream.on("error", (error) => {
            this.onerror?.(error);
        });
        stream.on("close", () => {
            this.stream = null;
            if (!this.closed) {
                this.onclose?.();
            }
        });
        void pipeJsonRpcMessages(stream, async (message) => {
            this.onmessage?.(message);
        });

        await new Promise<void>((resolve, reject) => {
            stream.once("response", () => resolve());
            stream.once("error", reject);
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        await this.start();
        const stream = this.stream;
        if (!stream || stream.closed || stream.destroyed) {
            throw new Error("hosted MCP client transport is closed");
        }
        writeJsonRpcMessage(stream, message);
    }

    async close(): Promise<void> {
        this.closed = true;
        this.stream?.end();
        this.session?.close();
        this.stream = null;
        this.session = null;
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

    async handleStream(
        stream: ServerHttp2Stream,
        _headers: IncomingHttpHeaders,
    ): Promise<void> {
        let processing = Promise.resolve();
        let writing = Promise.resolve();
        let responded = false;
        const responseHeaders = {
            ":status": 200,
            "content-type": "application/x-ndjson",
        };

        const ensureResponseStarted = () => {
            if (responded || stream.destroyed || stream.closed) {
                return;
            }
            stream.respond(responseHeaders);
            responded = true;
        };
        ensureResponseStarted();

        const writeMessage = async (message: JSONRPCMessage) => {
            writing = writing.then(async () => {
                if (stream.destroyed || stream.closed) {
                    return;
                }
                ensureResponseStarted();
                writeJsonRpcMessage(stream, message);
            });
            return writing;
        };

        const outboundHandler = (message: JSONRPCMessage) => writeMessage(message);
        const inbound = pipeJsonRpcMessages(stream, async (message) => {
            processing = processing.then(async () => {
                try {
                    const response = await this.handleMessage(message, outboundHandler);
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
            });
            await processing;
        });

        stream.on("end", () => {
            void Promise.all([inbound, processing, writing]).then(() => {
                if (stream.destroyed || stream.closed) {
                    return;
                }
                ensureResponseStarted();
                stream.end();
            }).catch((error) => {
                if (!stream.destroyed && !stream.closed) {
                    if (!responded) {
                        stream.respond({
                            ":status": 500,
                            "content-type": "application/json",
                        });
                        stream.end(
                            JSON.stringify(
                                encodeRpcError(
                                    null,
                                    -32603,
                                    error instanceof Error
                                        ? error.message
                                        : "internal error",
                                ),
                            ),
                        );
                        return;
                    }
                    stream.end();
                }
            });
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

function pipeJsonRpcMessages(
    stream: ServerHttp2Stream | ClientHttp2Stream,
    onMessage: (message: JSONRPCMessage) => Promise<void> | void,
): Promise<void> {
    let buffer = "";
    let drain = Promise.resolve();
    let settled = false;

    const finish = () => {
        if (settled) {
            return drain;
        }
        settled = true;
        const tail = buffer.trim();
        if (tail.length === 0) {
            return drain;
        }
        drain = drain.then(async () => {
            await onMessage(parseJsonRpcMessage(tail));
            buffer = "";
        });
        return drain;
    };

    stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        drain = drain.then(async () => {
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex >= 0) {
                const raw = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (raw.length > 0) {
                    await onMessage(parseJsonRpcMessage(raw));
                }
                newlineIndex = buffer.indexOf("\n");
            }
        });
        void drain.catch((error) => {
            stream.emit("error", error);
        });
    });
    return new Promise<void>((resolve, reject) => {
        stream.on("end", () => {
            void finish().then(resolve).catch((error) => {
                stream.emit("error", error);
                reject(error);
            });
        });
        stream.on("close", () => {
            void finish().then(resolve).catch(reject);
        });
        stream.on("error", reject);
    });
}

function writeJsonRpcMessage(
    stream: ServerHttp2Stream | ClientHttp2Stream,
    message: JSONRPCMessage,
): void {
    stream.write(`${JSON.stringify(message)}\n`);
}

function parseJsonRpcMessage(raw: string): JSONRPCMessage {
    return JSON.parse(raw) as JSONRPCMessage;
}
