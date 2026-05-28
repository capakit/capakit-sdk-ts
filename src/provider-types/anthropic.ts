import type { RunnerSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type AnthropicClient = import("@anthropic-ai/sdk").default;
export type AnthropicProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<AnthropicClient>;
};
export declare function anthropicProvider(sdk: RunnerSdk): AnthropicProvider;
