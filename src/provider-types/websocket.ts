import type { WorkloadSdk, ClientOptions, EndpointPath, WorkloadKey } from "../public-types.ts";

export type WebSocketClient = import("ws").default;
export declare function connectWebSocket(
    sdk: WorkloadSdk,
    workloadKey: WorkloadKey,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<WebSocketClient>;
