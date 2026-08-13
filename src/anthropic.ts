import type {
    ClientOptions,
    EndpointPath,
    WorkloadSdk,
    WorkloadKey,
} from "./public-types.ts";
import { registerSdkCloseableClient } from "./client-lifecycle.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import Anthropic from "@anthropic-ai/sdk";

export type AnthropicClient = Anthropic;

export async function createAnthropicClient(
    sdk: WorkloadSdk,
    workloadKey: WorkloadKey,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<AnthropicClient> {
    const endpoint = sdk.workloads.endpoint(workloadKey, endpointPath, options);
    const client = new Anthropic({
        apiKey: "capakit-local",
        baseURL: localEndpointBaseUrl(endpoint.endpoint),
        fetch: createExternalLlmFetch(endpoint.bind, endpoint.endpoint),
    });
    registerSdkCloseableClient(sdk, client);
    return client;
}
