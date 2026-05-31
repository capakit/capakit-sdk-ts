import type { RunnerSdk, RunnerSdkMount, RunnerHttpHandler, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type OaicClient = import("openai").default;
export type OaicMountOptions = { endpoint: string | EndpointPath; handler: RunnerHttpHandler };
export declare function createOaicClient(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<OaicClient>;
export declare function mountOaic(sdk: RunnerSdk, options: OaicMountOptions): void;
export declare function createOaicMount(options: OaicMountOptions): RunnerSdkMount;
