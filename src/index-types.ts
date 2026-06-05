export type * from "./public-types.ts";
export {
    endpointPath,
    hostMountMid,
    secretMid,
    workloadMid,
} from "./public-types.ts";
import type { WorkloadSdk, WorkloadSdkOptions } from "./public-types.ts";

export declare function createWorkloadSdk(options?: WorkloadSdkOptions): WorkloadSdk;
