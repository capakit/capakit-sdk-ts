import { describe, expect, test } from "vitest";

import {
    createHostedServer,
    listen,
} from "../src/transport.ts";
import { acceptWebSocket } from "../src/websocket.ts";

describe("acceptWebSocket", () => {
    test("echoes text and binary frames", async () => {
        const server = createHostedServer(
            async () => new Response("upgrade required", { status: 426 }),
            (request, socket, head) => {
                const ws = acceptWebSocket(request, socket, head);
                ws.onMessage((message) => {
                    if (typeof message === "string") {
                        ws.send(`echo: ${message}`);
                        return;
                    }
                    ws.send(message);
                });
            },
        );
        await listen(server, { kind: "tcp", host: "127.0.0.1", port: nextPort() });

        try {
            const address = server.address();
            if (address === null || typeof address === "string") {
                throw new Error("expected TCP address");
            }
            const client = await connectWebSocket(address.port);
            client.send("ping");
            await expect(readMessage(client)).resolves.toBe("echo: ping");

            client.send(new Uint8Array([1, 2, 3, 4]));
            const binary = await readMessage(client);
            expect(Array.from(new Uint8Array(await binaryBytes(binary)))).toEqual([1, 2, 3, 4]);
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

async function connectWebSocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
    });
    return socket;
}

async function readMessage(socket: WebSocket): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => resolve(event.data), { once: true });
        socket.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
    });
}

async function binaryBytes(value: unknown): Promise<ArrayBuffer> {
    if (value instanceof ArrayBuffer) {
        return value;
    }
    if (value instanceof Blob) {
        return await value.arrayBuffer();
    }
    throw new Error(`unexpected binary payload: ${typeof value}`);
}
