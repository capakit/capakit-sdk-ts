import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import { endpointPath } from "../src/public-types.ts";
import { listen } from "../src/transport.ts";
import { connectHostedWebSocket } from "../src/websocket.ts";

describe("connectHostedWebSocket", () => {
    test("connects through hosted bind", async () => {
        const server = createEchoServer("from-server");
        const port = nextPort();
        await listen(server, { kind: "tcp", host: "127.0.0.1", port });

        try {
            const client = await connectHostedWebSocket(
                { kind: "tcp", host: "127.0.0.1", port },
                endpointPath("/ws"),
            );
            const received = readMessage(client);
            client.send("hello");
            await expect(received).resolves.toBe("from-server: hello");
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });

    test("connects through hosted unix socket bind", async () => {
        const server = createEchoServer("from-uds");
        const path = join(tmpdir(), `capakit-sdk-ws-${process.pid}-${Date.now()}.sock`);
        await listen(server, { kind: "unix", path });

        try {
            const client = await connectHostedWebSocket({ kind: "unix", path }, endpointPath("/ws"));
            const received = readMessage(client);
            client.send("hello");
            await expect(received).resolves.toBe("from-uds: hello");
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });
});

let portCursor = 42000 + (process.pid % 10000);

function nextPort(): number {
    return portCursor++;
}

function createEchoServer(prefix: string) {
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    webSocketServer.on("connection", (socket) => {
        socket.on("message", (message, isBinary) => {
            if (!isBinary) {
                socket.send(`${prefix}: ${message.toString()}`);
                return;
            }
            socket.send(message);
        });
    });
    server.once("close", () => webSocketServer.close());
    return server;
}

async function readMessage(socket: WebSocket): Promise<string | RawData> {
    return await new Promise((resolve, reject) => {
        socket.once("message", (data, isBinary) => resolve(isBinary ? data : data.toString()));
        socket.once("error", () => reject(new Error("websocket error")));
    });
}
