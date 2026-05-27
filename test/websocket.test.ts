import { describe, expect, test } from "vitest";
import WebSocket, { type RawData } from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { endpointPath } from "../src/public-types.ts";
import {
    createHostedServer,
    listen,
} from "../src/transport.ts";
import { acceptWebSocket, connectHostedWebSocket } from "../src/websocket.ts";

describe("acceptWebSocket", () => {
    test("echoes text and binary frames", async () => {
        const server = createHostedServer(
            async () => new Response("upgrade required", { status: 426 }),
            (request, socket, head) => {
                const ws = acceptWebSocket(request, socket, head);
                ws.on("message", (message, isBinary) => {
                    if (!isBinary) {
                        ws.send(`echo: ${message.toString()}`);
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

    test("connects through hosted bind", async () => {
        const server = createHostedServer(
            async () => new Response("upgrade required", { status: 426 }),
            (request, socket, head) => {
                const ws = acceptWebSocket(request, socket, head);
                ws.on("message", (message) => ws.send(`from-server: ${message.toString()}`));
            },
        );
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
        const server = createHostedServer(
            async () => new Response("upgrade required", { status: 426 }),
            (request, socket, head) => {
                const ws = acceptWebSocket(request, socket, head);
                ws.on("message", (message) => ws.send(`from-uds: ${message.toString()}`));
            },
        );
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

async function connectWebSocket(port: number): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", () => reject(new Error("websocket error")));
    });
    return socket;
}

async function readMessage(socket: WebSocket): Promise<string | RawData> {
    return await new Promise((resolve, reject) => {
        socket.once("message", (data, isBinary) => resolve(isBinary ? data : data.toString()));
        socket.once("error", () => reject(new Error("websocket error")));
    });
}

async function binaryBytes(value: unknown): Promise<Uint8Array> {
    if (Buffer.isBuffer(value)) {
        return new Uint8Array(value);
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof Blob) {
        return new Uint8Array(await value.arrayBuffer());
    }
    throw new Error(`unexpected binary payload: ${typeof value}`);
}
