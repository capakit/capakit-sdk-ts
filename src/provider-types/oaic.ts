import type { RunnerSdk, RunnerSdkMount, RunnerHttpHandler, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type OaicClient = import("openai").default;
export type OaicMountOptions = { endpoint: EndpointPath; handler: RunnerHttpHandler };
export type OaicProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<OaicClient>;
    mount(options: OaicMountOptions): RunnerSdkMount;
};
export declare function oaicProvider(sdk: RunnerSdk): OaicProvider;
