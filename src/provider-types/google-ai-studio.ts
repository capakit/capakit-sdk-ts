import type { WorkloadSdk, ClientOptions, EndpointPath, WorkloadKey } from "../public-types.ts";

export type GoogleAiStudioClient = import("@google/genai").GoogleGenAI;
export declare function createGoogleAiStudioClient(
    sdk: WorkloadSdk,
    workloadKey: WorkloadKey,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<GoogleAiStudioClient>;
