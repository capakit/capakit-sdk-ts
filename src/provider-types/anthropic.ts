import type { WorkloadSdk, ClientOptions, EndpointPath, WorkloadKey } from "../public-types.ts";

export type AnthropicClient = import("@anthropic-ai/sdk").default;
export declare function createAnthropicClient(
    sdk: WorkloadSdk,
    workloadKey: WorkloadKey,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<AnthropicClient>;
