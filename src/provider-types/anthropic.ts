import type { WorkloadSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type AnthropicClient = import("@anthropic-ai/sdk").default;
export declare function createAnthropicClient(
    sdk: WorkloadSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<AnthropicClient>;
