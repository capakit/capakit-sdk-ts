import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";

import type { EndpointPath, HostedBind, RunnerWebSocket, RunnerWebSocketMessage } from "./public-types.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type MessageHandler = (message: RunnerWebSocketMessage) => void | Promise<void>;
type CloseHandler = () => void | Promise<void>;
type HeaderRecord = Record<string, string | string[] | undefined>;

export function acceptWebSocket(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): RunnerWebSocket {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
        socket.destroy();
        throw new Error("missing sec-websocket-key");
    }

    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
    ].join("\r\n"));

    const ws = new HostedWebSocket(socket);
    ws.start(head);
    return ws;
}

export async function connectHostedWebSocket(
    bind: HostedBind,
    endpoint: EndpointPath,
    signal?: AbortSignal,
): Promise<RunnerWebSocket> {
    if (signal?.aborted) {
        throw new Error("websocket request aborted");
    }
    return await new Promise<RunnerWebSocket>((resolve, reject) => {
        let settled = false;
        const key = createWebSocketKey();
        const socket = connectRawSocket(bind);
        let buffer = Buffer.alloc(0);
        const abort = () => {
            if (!settled) {
                settled = true;
                reject(new Error("websocket request aborted"));
            }
            socket.destroy(new Error("websocket request aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        socket.on("connect", () => {
            socket.write(webSocketUpgradeRequest(endpoint, key));
        });
        socket.on("data", (chunk) => {
            if (settled) {
                return;
            }
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            const splitAt = buffer.indexOf("\r\n\r\n");
            if (splitAt < 0) {
                return;
            }
            signal?.removeEventListener("abort", abort);
            try {
                const head = buffer.subarray(splitAt + 4);
                const response = parseUpgradeResponse(buffer.subarray(0, splitAt).toString("latin1"));
                validateWebSocketUpgrade(response.statusCode, response.headers, key);
                const ws = new HostedWebSocket(socket);
                ws.start(head);
                settled = true;
                resolve(ws);
            } catch (error) {
                settled = true;
                socket.destroy();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.on("error", (error) => {
            signal?.removeEventListener("abort", abort);
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
    });
}

class HostedWebSocket implements RunnerWebSocket {
    private readonly socket: Duplex;
    private buffer = Buffer.alloc(0);
    private messageHandlers: MessageHandler[] = [];
    private closeHandlers: CloseHandler[] = [];
    private closed = false;

    constructor(socket: Duplex) {
        this.socket = socket;
    }

    start(head: Buffer): void {
        this.socket.on("data", (chunk) => this.handleData(Buffer.from(chunk)));
        this.socket.on("close", () => this.emitClose());
        this.socket.on("error", () => this.emitClose());
        this.socket.resume();
        if (head.length > 0) {
            this.handleData(head);
        }
    }

    send(message: RunnerWebSocketMessage): void {
        if (this.closed) {
            return;
        }
        const opcode = typeof message === "string" ? 0x1 : 0x2;
        const payload = Buffer.from(message);
        this.socket.write(encodeFrame(opcode, payload));
    }

    close(code = 1000, reason = ""): void {
        if (this.closed) {
            return;
        }
        const reasonBytes = Buffer.from(reason);
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        this.socket.write(encodeFrame(0x8, payload));
        this.socket.end();
        this.emitClose();
    }

    onMessage(handler: MessageHandler): void {
        this.messageHandlers.push(handler);
    }

    onClose(handler: CloseHandler): void {
        this.closeHandlers.push(handler);
    }

    private handleData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            const frame = decodeFrame(this.buffer);
            if (!frame) {
                return;
            }
            this.buffer = this.buffer.subarray(frame.consumed);
            this.handleFrame(frame.opcode, frame.payload);
        }
    }

    private handleFrame(opcode: number, payload: Buffer): void {
        if (opcode === 0x1) {
            this.emitMessage(payload.toString("utf8"));
            return;
        }
        if (opcode === 0x2) {
            this.emitMessage(new Uint8Array(payload));
            return;
        }
        if (opcode === 0x8) {
            this.socket.end(encodeFrame(0x8, payload));
            this.emitClose();
            return;
        }
        if (opcode === 0x9) {
            this.socket.write(encodeFrame(0xA, payload));
        }
    }

    private emitMessage(message: RunnerWebSocketMessage): void {
        for (const handler of this.messageHandlers) {
            void Promise.resolve(handler(message)).catch(() => this.close(1011, "handler error"));
        }
    }

    private emitClose(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const handler of this.closeHandlers) {
            void Promise.resolve(handler()).catch(() => {});
        }
    }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    if (length < 126) {
        return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
    }
    if (length <= 0xFFFF) {
        const header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
        return Buffer.concat([header, payload]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    return Buffer.concat([header, payload]);
}

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
    if (buffer.length < 2) {
        return null;
    }
    const opcode = buffer[0] & 0x0F;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7F;
    let offset = 2;
    if (length === 126) {
        if (buffer.length < offset + 2) return null;
        length = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (length === 127) {
        if (buffer.length < offset + 8) return null;
        const raw = buffer.readBigUInt64BE(offset);
        if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("websocket frame too large");
        }
        length = Number(raw);
        offset += 8;
    }
    const maskOffset = offset;
    if (masked) {
        offset += 4;
    }
    if (buffer.length < offset + length) {
        return null;
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

function createWebSocketKey(): string {
    return randomBytes(16).toString("base64");
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

function webSocketUpgradeRequest(endpoint: EndpointPath, key: string): string {
    return [
        `GET ${endpoint} HTTP/1.1`,
        "Host: localhost",
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
    ].join("\r\n");
}

function parseUpgradeResponse(raw: string): { statusCode: number; headers: HeaderRecord } {
    const [statusLine = "", ...headerLines] = raw.split("\r\n");
    const statusCode = Number(statusLine.split(/\s+/)[1]);
    const headers: HeaderRecord = {};
    for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator < 0) {
            continue;
        }
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const existing = headers[name];
        if (Array.isArray(existing)) {
            existing.push(value);
        } else if (typeof existing === "string") {
            headers[name] = [existing, value];
        } else {
            headers[name] = value;
        }
    }
    return { statusCode, headers };
}

function validateWebSocketUpgrade(statusCode: number | undefined, headers: HeaderRecord, key: string): void {
    if (statusCode !== 101) {
        throw new Error(`websocket upgrade failed with status ${statusCode ?? "unknown"}`);
    }
    if (!headerContainsToken(headers.connection, "upgrade")) {
        throw new Error("websocket upgrade response missing connection upgrade token");
    }
    if (headerValue(headers.upgrade).toLowerCase() !== "websocket") {
        throw new Error("websocket upgrade response missing websocket upgrade header");
    }
    const expectedAccept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    if (headerValue(headers["sec-websocket-accept"]) !== expectedAccept) {
        throw new Error("websocket upgrade response had invalid accept key");
    }
}

function headerContainsToken(value: string | string[] | undefined, token: string): boolean {
    return headerValue(value)
        .split(",")
        .some((part) => part.trim().toLowerCase() === token.toLowerCase());
}

function headerValue(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? "";
    }
    return value ?? "";
}
