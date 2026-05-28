import type { RunnerSdk, RunnerSdkMount, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type A2aAgentCard = import("@a2a-js/sdk").AgentCard;
export type A2aAgentExecutor = import("@a2a-js/sdk/server").AgentExecutor;
export type A2aTaskStore = import("@a2a-js/sdk/server").TaskStore;
export type A2aClient = import("@a2a-js/sdk/client").A2AClient;
export type A2aMountOptions = {
    endpoint: EndpointPath;
    agentCard: A2aAgentCard;
    executor: A2aAgentExecutor;
    taskStore?: A2aTaskStore;
};
export type A2aProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<A2aClient>;
    mount(options: A2aMountOptions): RunnerSdkMount;
};
export declare function a2aProvider(sdk: RunnerSdk): A2aProvider;
