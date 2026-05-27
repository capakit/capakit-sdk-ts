import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
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
        const webSocket = new WebSocket(`ws://localhost${endpoint}`, {
            createConnection: () => connectRawSocket(bind),
        });

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
            settle({ error: error instanceof Error ? error : new Error(String(error)) });
        });
    });
}

function connectRawSocket(bind: HostedBind): Duplex {
    if (bind.kind === "unix") {
        return createConnection({ path: bind.path });
    }
    if (bind.kind === "pipe") {
        return createConnection({ path: bind.name });
    }
    return createConnection({ host: bind.host, port: bind.port });
}
