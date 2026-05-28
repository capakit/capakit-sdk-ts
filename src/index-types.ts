export type * from "./public-types.ts";
export {
    endpointPath,
    hostMountMid,
    secretMid,
    workloadMid,
} from "./public-types.ts";
import type { RunnerSdk, RunnerSdkOptions } from "./public-types.ts";

export declare function createRunnerSdk(options?: RunnerSdkOptions): RunnerSdk;
