import type { RunnerSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type WebSocketClient = import("ws").default;
export type WebSocketProvider = {
    connect(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<WebSocketClient>;
};
export declare function webSocketProvider(sdk: RunnerSdk): WebSocketProvider;
