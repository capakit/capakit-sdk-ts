import type { WorkloadSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type WebSocketClient = import("ws").default;
export declare function connectWebSocket(
    sdk: WorkloadSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<WebSocketClient>;
