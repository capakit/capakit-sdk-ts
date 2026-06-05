import type { WorkloadSdk, WorkloadHttpHandler, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type OaicClient = import("openai").default;
export type OaicMountOptions = { endpoint: string | EndpointPath; handler: WorkloadHttpHandler };
export declare function createOaicClient(
    sdk: WorkloadSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<OaicClient>;
export declare function mountOaic(sdk: WorkloadSdk, options: OaicMountOptions): void;
