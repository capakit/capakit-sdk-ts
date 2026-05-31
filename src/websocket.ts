import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";

import type WebSocket from "ws";

import type {
    ClientOptions,
    EndpointPath,
    HostedBind,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";
import { registerSdkClientCleanup } from "./client-lifecycle.ts";

const require = createRequire(import.meta.url);
const wsRoot = dirname(require.resolve("ws/package.json"));
const wsModule = require(join(wsRoot, "index.js")) as typeof import("ws");
const WebSocketCtor = (wsModule.WebSocket ?? wsModule) as unknown as RawWebSocketConstructor;
const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const RAW_WEB_SOCKET_OPTIONS = {
    allowSynchronousEvents: true,
    autoPong: true,
    closeTimeout: 30_000,
    maxBufferedChunks: 1024 * 1024,
    maxFragments: 128 * 1024,
    maxPayload: 100 * 1024 * 1024,
    skipUTF8Validation: false,
};

type RawWebSocket = WebSocket & {
    _isServer: boolean;
    _url: string;
    setSocket(socket: Socket, head: Buffer, options: typeof RAW_WEB_SOCKET_OPTIONS): void;
};

type RawWebSocketConstructor = {
    CLOSED: number;
    new(
        address: string | URL | null,
        protocols?: string | string[],
        options?: typeof RAW_WEB_SOCKET_OPTIONS,
    ): RawWebSocket;
};

export type WebSocketClient = WebSocket;

export async function connectWebSocket(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<WebSocketClient> {
    const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
    const webSocket = await connectHostedWebSocket(
        endpoint.bind,
        endpoint.endpoint,
        options.signal,
    );
    registerSdkClientCleanup(sdk, () => {
        if (webSocket.readyState === WebSocketCtor.CLOSED) {
            return;
        }
        webSocket.terminate();
    });
    return webSocket;
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
        const webSocket = new WebSocketCtor(webSocketUrl(bind, endpoint));

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
        const url = webSocketUrl(bind, endpoint);
        const webSocket = newRawWebSocket(url);

        const settle = (result: { webSocket: WebSocket } | { error: Error }): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal?.removeEventListener("abort", abort);
            socket.off("connect", onConnect);
            socket.off("data", onData);
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
        const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            const headerEnd = buffered.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                return;
            }
            try {
                assertUpgradeAccepted(buffered.subarray(0, headerEnd).toString("latin1"), key);
                const head = buffered.subarray(headerEnd + 4);
                socket.off("connect", onConnect);
                socket.off("data", onData);
                socket.off("error", onError);
                webSocket.setSocket(socket, head, RAW_WEB_SOCKET_OPTIONS);
                settle({ webSocket });
            } catch (error) {
                settle({ error: normalizeError(error) });
            }
        };
        const onError = (error: Error): void => {
            settle({ error: normalizeError(error) });
        };

        signal?.addEventListener("abort", abort, { once: true });
        socket.once("connect", onConnect);
        socket.on("data", onData);
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

function newRawWebSocket(url: string): RawWebSocket {
    const webSocket = new WebSocketCtor(
        null as never,
        undefined,
        RAW_WEB_SOCKET_OPTIONS,
    ) as RawWebSocket;
    webSocket._isServer = false;
    webSocket._url = url;
    return webSocket;
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
