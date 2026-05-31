import WebSocket from "ws";

import type {
    ClientOptions,
    EndpointPath,
    HostedBind,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";

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

function webSocketUrl(bind: HostedBind, endpoint: EndpointPath): string {
    if (bind.kind === "unix") {
        return `ws+unix:${bind.path}:${endpoint}`;
    }
    if (bind.kind === "tcp") {
        return `ws://${bind.host}:${bind.port}${endpoint}`;
    }
    return `ws+unix:${bind.name}:${endpoint}`;
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
