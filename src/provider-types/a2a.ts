import type { RunnerSdk, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type A2aAgentCard = import("@a2a-js/sdk").AgentCard;
export type A2aAgentExecutor = import("@a2a-js/sdk/server").AgentExecutor;
export type A2aTaskStore = import("@a2a-js/sdk/server").TaskStore;
export type A2aClient = import("@a2a-js/sdk/client").A2AClient;
export type A2aMountOptions = {
    endpoint: string | EndpointPath;
    agentCard: A2aAgentCard;
    executor: A2aAgentExecutor;
    taskStore?: A2aTaskStore;
};
export declare function createA2aClient(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<A2aClient>;
export declare function mountA2a(sdk: RunnerSdk, options: A2aMountOptions): void;
