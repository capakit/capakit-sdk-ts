import type {
    ClientOptions,
    EndpointPath,
    RunnerSdk,
    WorkloadMid,
} from "./public-types.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import { optionalModule } from "./optional-imports.ts";

export type GoogleAiStudioClient = import("@google/genai").GoogleGenAI;

export type GoogleAiStudioProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<GoogleAiStudioClient>;
};

export function googleAiStudioProvider(sdk: RunnerSdk): GoogleAiStudioProvider {
    return {
        async createClient(workloadMid, endpointPath, options = {}) {
            const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
            const hostedFetch = createExternalLlmFetch(endpoint.bind, endpoint.endpoint);
            const defaultFetch = globalThis.fetch.bind(globalThis);
            const { GoogleGenAI } = await import(optionalModule("@google/genai"));
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
        },
    };
}
