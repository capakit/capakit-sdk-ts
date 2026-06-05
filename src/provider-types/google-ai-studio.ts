import type { WorkloadSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type GoogleAiStudioClient = import("@google/genai").GoogleGenAI;
export declare function createGoogleAiStudioClient(
    sdk: WorkloadSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<GoogleAiStudioClient>;
