import type {
    ClientOptions,
    EndpointPath,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import { GoogleGenAI } from "@google/genai";

export type GoogleAiStudioClient = GoogleGenAI;

export async function createGoogleAiStudioClient(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<GoogleAiStudioClient> {
    const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
    const hostedFetch = createExternalLlmFetch(endpoint.bind, endpoint.endpoint);
    const defaultFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "capakit.local") {
            return hostedFetch(request);
        }
        return defaultFetch(request);
    };
    return new GoogleGenAI({
        apiKey: "capakit-local",
        httpOptions: {
            baseUrl: localEndpointBaseUrl(endpoint.endpoint),
            apiVersion: "v1beta",
        },
    });
}
