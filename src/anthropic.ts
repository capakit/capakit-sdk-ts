import type {
    ClientOptions,
    EndpointPath,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import Anthropic from "@anthropic-ai/sdk";

export type AnthropicClient = Anthropic;

export async function createAnthropicClient(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<AnthropicClient> {
    const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
    return new Anthropic({
        apiKey: "capakit-local",
        baseURL: localEndpointBaseUrl(endpoint.endpoint),
        fetch: createExternalLlmFetch(endpoint.bind, endpoint.endpoint),
    });
}
