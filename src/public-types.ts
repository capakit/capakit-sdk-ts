import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

declare const CAPAKIT_BRAND: unique symbol;

type Brand<T, Name extends string> = T & {
    readonly [CAPAKIT_BRAND]: Name;
};

export type HostedBindValue = string;
export type PresenceId = string;
export type McpSessionId = string;
export type EndpointPath = Brand<string, "EndpointPath">;
export type WorkloadMid = Brand<string, "WorkloadMid">;
export type SecretMid = Brand<string, "SecretMid">;
export type HostMountMid = Brand<string, "HostMountMid">;
export type RunnerProtocol = "http" | "mcp" | "oaic" | "a2a";
export type HostMountAccess = "read_only" | "read_write";
export type A2aAgentCard = unknown;
export type A2aAgentExecutor = unknown;
export type A2aTaskStore = unknown;
export type A2aClient = unknown;
export type AnthropicClient = unknown;
export type GoogleAiStudioClient = unknown;
export type OaicClient = unknown;
export type WebSocketClient = unknown;

export type HostedBind =
    | { kind: "unix"; path: string }
    | { kind: "tcp"; host: string; port: number }
    | { kind: "pipe"; name: string };

export function endpointPath(value: string): EndpointPath {
    if (value.length === 0) {
        throw new Error("endpoint path must not be empty");
    }
    return (value.startsWith("/") ? value : `/${value}`) as EndpointPath;
}

export function workloadMid(value: string): WorkloadMid {
    return value as WorkloadMid;
}

export function secretMid(value: string): SecretMid {
    return value as SecretMid;
}

export function hostMountMid(value: string): HostMountMid {
    return value as HostMountMid;
}

export type ClientOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

export type RunnerWorkloadConnection = {
    workloadMid: WorkloadMid;
    endpoint: EndpointPath;
    protocol: RunnerProtocol;
};

export type RunnerWorkloads = {
    readonly workloads: ReadonlyArray<RunnerWorkloadConnection>;
    mcpClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<McpClient>;
    oaicClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<OaicClient>;
    anthropicClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<AnthropicClient>;
    googleAiStudioClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<GoogleAiStudioClient>;
    a2aClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<A2aClient>;
    webSocket(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<WebSocketClient>;
    close(): Promise<void>;
};

export type RunnerSecrets = {
    resolve(secretMid: SecretMid): Promise<string>;
    close(): Promise<void>;
};

export type HostMount = {
    mid: HostMountMid;
    path: string;
    access: HostMountAccess;
};

export type RunnerMounts = {
    get(mountMid: HostMountMid): HostMount | undefined;
    list(): readonly HostMount[];
};

export type RunnerSdkOptions = {
    bind?: HostedBindValue;
    onPresenceStart?: RunnerPresenceLifecycleHook;
    onShutdown?: RunnerShutdownHook;
};

export type RunnerMcpMount = {
    protocol: "mcp";
    endpoint: EndpointPath;
    server: McpServer;
};

export type RunnerHttpHandlerContext = RunnerPresenceLifecycleContext & {
    protocol: Exclude<RunnerProtocol, "mcp">;
    endpoint: EndpointPath;
};

export type RunnerHttpHandler = (
    request: Request,
    context: RunnerHttpHandlerContext,
) => Response | Promise<Response>;

export type RunnerOaicMount = {
    protocol: "oaic";
    endpoint: EndpointPath;
    handler: RunnerHttpHandler;
};

export type RunnerHttpMount = {
    protocol: "http";
    endpoint: EndpointPath;
    handler: RunnerHttpHandler;
};

export type RunnerA2aMount = {
    protocol: "a2a";
    endpoint: EndpointPath;
    agentCard: A2aAgentCard;
    executor: A2aAgentExecutor;
    taskStore?: A2aTaskStore;
};

export type RunnerSdkMount =
    | RunnerMcpMount
    | RunnerHttpMount
    | RunnerOaicMount
    | RunnerA2aMount;

export type RunnerSignal = "SIGINT" | "SIGTERM";

export type RunnerPresenceLifecycleContext = {
    presenceId?: PresenceId;
    workloadMid?: WorkloadMid;
};

export type RunnerShutdownCause =
    | { kind: "signal"; signal: RunnerSignal }
    | { kind: "orphaned"; initialParentPid: number }
    | { kind: "stop" };

export type RunnerShutdownContext = RunnerPresenceLifecycleContext & {
    cause: RunnerShutdownCause;
};

export type RunnerPresenceLifecycleHook = (
    context: RunnerPresenceLifecycleContext,
) => void | Promise<void>;

export type RunnerShutdownHook = (
    context: RunnerShutdownContext,
) => void | Promise<void>;

export type RunnerSdk = {
    readonly workloads: RunnerWorkloads;
    readonly secrets: RunnerSecrets;
    readonly mounts: RunnerMounts;
    mount(mount: RunnerSdkMount): void;
    hijackConsoleLogging(): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
};
