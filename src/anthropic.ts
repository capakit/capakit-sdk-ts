import type {
    ClientOptions,
    EndpointPath,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import { optionalModule } from "./optional-imports.ts";

export type AnthropicClient = import("@anthropic-ai/sdk").default;

export type AnthropicProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<AnthropicClient>;
};

export function anthropicProvider(sdk: RunnerSdk): AnthropicProvider {
    return {
        async createClient(workloadMid, endpointPath, options = {}) {
            const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
            const { default: Anthropic } = await import(optionalModule("@anthropic-ai/sdk"));
            return new Anthropic({
                apiKey: "capakit-local",
                baseURL: localEndpointBaseUrl(endpoint.endpoint),
                fetch: createExternalLlmFetch(endpoint.bind, endpoint.endpoint),
            });
        },
    };
}
