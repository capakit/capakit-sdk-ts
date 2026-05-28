import type { RunnerSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type GoogleAiStudioClient = import("@google/genai").GoogleGenAI;
export type GoogleAiStudioProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<GoogleAiStudioClient>;
};
export declare function googleAiStudioProvider(sdk: RunnerSdk): GoogleAiStudioProvider;
