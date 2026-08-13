export type * from "./public-types.ts";
export {
    endpointPath,
    hostMountKey,
    secretKey,
    workloadKey,
} from "./public-types.ts";
import type { WorkloadSdk, WorkloadSdkOptions } from "./public-types.ts";

export declare function createWorkloadSdk(options?: WorkloadSdkOptions): WorkloadSdk;
export declare function reportWorkloadReady(): Promise<void>;
