import type { IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import type { EndpointPath, HostedBind } from "./public-types.ts";

export function acceptWebSocket(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): WebSocket {
    const server = new WebSocketServer({ noServer: true });
    let accepted: WebSocket | undefined;
    server.handleUpgrade(request, socket, head, (webSocket) => {
        accepted = webSocket;
    });
    server.close();
    if (!accepted) {
        socket.destroy();
        throw new Error("websocket upgrade was not accepted");
    }
    return accepted;
}

export async function connectHostedWebSocket(
    bind: HostedBind,
    endpoint: EndpointPath,
    signal?: AbortSignal,
): Promise<WebSocket> {
    if (signal?.aborted) {
        throw new Error("websocket request aborted");
    }

    return await new Promise<WebSocket>((resolve, reject) => {
        let settled = false;
        const webSocket = new WebSocket(webSocketUrl(bind, endpoint), webSocketOptions(bind));

        const settle = (result: { webSocket: WebSocket } | { error: Error }): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener("abort", abort);
            if ("error" in result) {
                webSocket.terminate();
                reject(result.error);
                return;
            }
            resolve(result.webSocket);
        };
        const abort = (): void => {
            settle({ error: new Error("websocket request aborted") });
        };

        signal?.addEventListener("abort", abort, { once: true });
        webSocket.once("open", () => settle({ webSocket }));
        webSocket.once("error", (error) => {
            settle({ error: normalizeError(error) });
        });
    });
}

function webSocketUrl(bind: HostedBind, endpoint: EndpointPath): string {
    if (bind.kind === "unix") {
        return `ws+unix://${bind.path}:${endpoint}`;
    }
    if (bind.kind === "tcp") {
        return `ws://${bind.host}:${bind.port}${endpoint}`;
    }
    return `ws://localhost${endpoint}`;
}

function webSocketOptions(bind: HostedBind): WebSocket.ClientOptions | undefined {
    if (bind.kind !== "pipe") {
        return undefined;
    }
    return {
        createConnection: () => connectRawSocket(bind),
    };
}

function connectRawSocket(bind: HostedBind): Socket {
    if (bind.kind === "pipe") {
        return createConnection({ path: bind.name });
    }
    throw new Error(`raw websocket socket unsupported for bind kind ${bind.kind}`);
}

function normalizeError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (
        typeof error === "object"
        && error !== null
        && "error" in error
        && error.error instanceof Error
    ) {
        return error.error;
    }
    if (
        typeof error === "object"
        && error !== null
        && "message" in error
        && typeof error.message === "string"
    ) {
        return new Error(error.message);
    }
    return new Error(String(error));
}
