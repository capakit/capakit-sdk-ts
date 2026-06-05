import type {
    ClientOptions,
    EndpointPath,
    WorkloadSdk,
    WorkloadMid,
} from "./public-types.ts";
import { registerSdkCloseableClient } from "./client-lifecycle.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import Anthropic from "@anthropic-ai/sdk";

export type AnthropicClient = Anthropic;

export async function createAnthropicClient(
    sdk: WorkloadSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<AnthropicClient> {
    const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
    const client = new Anthropic({
        apiKey: "capakit-local",
        baseURL: localEndpointBaseUrl(endpoint.endpoint),
        fetch: createExternalLlmFetch(endpoint.bind, endpoint.endpoint),
    });
    registerSdkCloseableClient(sdk, client);
    return client;
}
