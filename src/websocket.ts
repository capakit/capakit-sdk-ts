import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

import WebSocket from "ws";

import type {
    ClientOptions,
    EndpointPath,
    HostedBind,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type WebSocketClient = WebSocket;

export async function connectWebSocket(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<WebSocketClient> {
    const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
    return await connectHostedWebSocket(
        endpoint.bind,
        endpoint.endpoint,
        options.signal,
    );
}

export async function connectHostedWebSocket(
    bind: HostedBind,
    endpoint: EndpointPath,
    signal?: AbortSignal,
): Promise<WebSocket> {
    if (bind.kind === "unix" || bind.kind === "pipe") {
        return await connectRawHostedWebSocket(bind, endpoint, signal);
    }
    if (signal?.aborted) {
        throw new Error("websocket request aborted");
    }

    return await new Promise<WebSocket>((resolve, reject) => {
        let settled = false;
        const webSocket = new WebSocket(webSocketUrl(bind, endpoint));

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

async function connectRawHostedWebSocket(
    bind: HostedBind,
    endpoint: EndpointPath,
    signal?: AbortSignal,
): Promise<WebSocket> {
    if (signal?.aborted) {
        throw new Error("websocket request aborted");
    }

    return await new Promise<WebSocket>((resolve, reject) => {
        let settled = false;
        let buffered = Buffer.alloc(0);
        const socket = connectRawSocket(bind);
        const key = randomBytes(16).toString("base64");

        const settle = (result: { webSocket: WebSocket } | { error: Error }): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener("abort", abort);
            socket.off("connect", onConnect);
            socket.off("data", onHandshakeData);
            socket.off("error", onError);
            if ("error" in result) {
                socket.destroy();
                reject(result.error);
                return;
            }
            resolve(result.webSocket);
        };
        const abort = (): void => {
            settle({ error: new Error("websocket request aborted") });
        };
        const onConnect = (): void => {
            socket.write(rawUpgradeRequest(endpoint, key));
        };
        const onHandshakeData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            const headerEnd = buffered.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                return;
            }
            try {
                assertUpgradeAccepted(buffered.subarray(0, headerEnd).toString("latin1"), key);
                socket.off("connect", onConnect);
                socket.off("data", onHandshakeData);
                socket.off("error", onError);
                const webSocket = new RawHostedWebSocket(socket, buffered.subarray(headerEnd + 4));
                settle({ webSocket: webSocket as unknown as WebSocket });
            } catch (error) {
                settle({ error: normalizeError(error) });
            }
        };
        const onError = (error: Error): void => {
            settle({ error: normalizeError(error) });
        };

        signal?.addEventListener("abort", abort, { once: true });
        socket.once("connect", onConnect);
        socket.on("data", onHandshakeData);
        socket.once("error", onError);
    });
}

function webSocketUrl(bind: HostedBind, endpoint: EndpointPath): string {
    if (bind.kind === "unix") {
        return `ws://localhost${endpoint}`;
    }
    if (bind.kind === "tcp") {
        return `ws://${bind.host}:${bind.port}${endpoint}`;
    }
    return `ws://localhost${endpoint}`;
}

function connectRawSocket(bind: HostedBind): Socket {
    if (bind.kind === "unix") {
        return createConnection({ path: bind.path });
    }
    if (bind.kind === "pipe") {
        return createConnection({ path: bind.name });
    }
    throw new Error(`raw websocket socket unsupported for bind kind ${bind.kind}`);
}

function rawUpgradeRequest(endpoint: EndpointPath, key: string): string {
    return [
        `GET ${endpoint} HTTP/1.1`,
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
    ].join("\r\n");
}

function assertUpgradeAccepted(responseHead: string, key: string): void {
    const lines = responseHead.split("\r\n");
    const status = lines.shift();
    if (!status?.startsWith("HTTP/1.1 101 ") && !status?.startsWith("HTTP/1.0 101 ")) {
        throw new Error(`unexpected websocket upgrade response: ${status ?? "<empty>"}`);
    }
    const headers = new Map<string, string>();
    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator > 0) {
            headers.set(
                line.slice(0, separator).trim().toLowerCase(),
                line.slice(separator + 1).trim(),
            );
        }
    }
    const accept = createHash("sha1").update(key + WEB_SOCKET_GUID).digest("base64");
    if (headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new Error("invalid websocket upgrade header");
    }
    if (headers.get("sec-websocket-accept") !== accept) {
        throw new Error("invalid websocket accept header");
    }
}

class RawHostedWebSocket extends EventEmitter {
    private buffered: Buffer;
    private closed = false;

    constructor(
        private readonly socket: Socket,
        head: Buffer,
    ) {
        super();
        this.buffered = head;
        this.socket.on("data", (chunk) => this.onData(chunk));
        this.socket.once("error", (error) => this.emit("error", normalizeError(error)));
        this.socket.once("close", () => {
            this.closed = true;
            this.emit("close");
        });
        if (this.buffered.length > 0) {
            this.drainFrames();
        }
    }

    send(data: string | ArrayBuffer | ArrayBufferView | Buffer): void {
        if (this.closed) {
            throw new Error("websocket is closed");
        }
        const isText = typeof data === "string";
        const payload = isText ? Buffer.from(data) : Buffer.from(asBytes(data));
        this.socket.write(encodeClientFrame(isText ? 0x1 : 0x2, payload));
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
        this.socket.end();
    }

    terminate(): void {
        this.socket.destroy();
    }

    private onData(chunk: Buffer): void {
        this.buffered = Buffer.concat([this.buffered, chunk]);
        this.drainFrames();
    }

    private drainFrames(): void {
        while (true) {
            const frame = readFrame(this.buffered);
            if (!frame) {
                return;
            }
            this.buffered = this.buffered.subarray(frame.consumed);
            if (frame.opcode === 0x1) {
                this.emit("message", frame.payload.toString(), false);
            } else if (frame.opcode === 0x2) {
                this.emit("message", frame.payload, true);
            } else if (frame.opcode === 0x8) {
                this.closed = true;
                this.socket.end();
                this.emit("close");
            } else if (frame.opcode === 0x9) {
                this.socket.write(encodeClientFrame(0xA, frame.payload));
            }
        }
    }
}

type DecodedFrame = {
    opcode: number;
    payload: Buffer;
    consumed: number;
};

function readFrame(buffer: Buffer): DecodedFrame | undefined {
    if (buffer.length < 2) {
        return undefined;
    }
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buffer.length < offset + 2) {
            return undefined;
        }
        length = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (length === 127) {
        if (buffer.length < offset + 8) {
            return undefined;
        }
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("websocket frame is too large");
        }
        length = Number(bigLength);
        offset += 8;
    }
    const maskOffset = offset;
    if (masked) {
        offset += 4;
    }
    if (buffer.length < offset + length) {
        return undefined;
    }
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
        }
    }
    return {
        opcode,
        payload,
        consumed: offset + length,
    };
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
    const header = Buffer.alloc(2 + lengthBytes + 4);
    header[0] = 0x80 | opcode;
    if (length < 126) {
        header[1] = 0x80 | length;
    } else if (length <= 0xffff) {
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
    } else {
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    const maskOffset = 2 + lengthBytes;
    const mask = randomBytes(4);
    mask.copy(header, maskOffset);
    const masked = Buffer.from(payload);
    for (let index = 0; index < masked.length; index += 1) {
        masked[index] ^= mask[index % 4];
    }
    return Buffer.concat([header, masked]);
}

function asBytes(value: ArrayBuffer | ArrayBufferView | Buffer): Uint8Array {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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
