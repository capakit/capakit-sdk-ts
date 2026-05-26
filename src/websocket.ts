import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { RunnerWebSocket, RunnerWebSocketMessage } from "./public-types.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type MessageHandler = (message: RunnerWebSocketMessage) => void | Promise<void>;
type CloseHandler = () => void | Promise<void>;

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

class HostedWebSocket implements RunnerWebSocket {
    private buffer = Buffer.alloc(0);
    private messageHandlers: MessageHandler[] = [];
    private closeHandlers: CloseHandler[] = [];
    private closed = false;

    constructor(private readonly socket: Duplex) {}

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
