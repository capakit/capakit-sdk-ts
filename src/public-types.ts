import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentCard } from "@a2a-js/sdk";
import type { A2AClient } from "@a2a-js/sdk/client";
import type { AgentExecutor, TaskStore } from "@a2a-js/sdk/server";
import type Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

declare const CAPAKIT_BRAND: unique symbol;

type Brand<T, Name extends string> = T & {
    readonly [CAPAKIT_BRAND]: Name;
};

export type HostedBindValue = string;
export type SessionId = string;
export type EndpointPath = Brand<string, "EndpointPath">;
export type WorkloadMid = Brand<string, "WorkloadMid">;
export type SecretMid = Brand<string, "SecretMid">;
export type RunnerProtocol = "mcp" | "oaic" | "a2a";

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

export type ClientOptions = {
    signal?: AbortSignal;
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
    ): Promise<OpenAI>;
    anthropicClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<Anthropic>;
    googleAiStudioClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<GoogleGenAI>;
    a2aClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<A2AClient>;
    close(): Promise<void>;
};

export type RunnerSecrets = {
    resolve(secretMid: SecretMid): Promise<string>;
    close(): Promise<void>;
};

export type RunnerSdkOptions = {
    bind?: HostedBindValue;
    onSessionStart?: RunnerSessionLifecycleHook;
    onShutdown?: RunnerShutdownHook;
};

export type RunnerMcpMount = {
    protocol: "mcp";
    endpoint: EndpointPath;
    server: McpServer;
};

export type RunnerHttpHandlerContext = RunnerSessionLifecycleContext & {
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

export type RunnerA2aMount = {
    protocol: "a2a";
    endpoint: EndpointPath;
    agentCard: AgentCard;
    executor: AgentExecutor;
    taskStore?: TaskStore;
};

export type RunnerSdkMount = RunnerMcpMount | RunnerOaicMount | RunnerA2aMount;

export type RunnerSignal = "SIGINT" | "SIGTERM";

export type RunnerSessionLifecycleContext = {
    sessionId?: SessionId;
    workloadMid?: WorkloadMid;
};

export type RunnerShutdownCause =
    | { kind: "signal"; signal: RunnerSignal }
    | { kind: "orphaned"; initialParentPid: number }
    | { kind: "stop" };

export type RunnerShutdownContext = RunnerSessionLifecycleContext & {
    cause: RunnerShutdownCause;
};

export type RunnerSessionLifecycleHook = (
    context: RunnerSessionLifecycleContext,
) => void | Promise<void>;

export type RunnerShutdownHook = (
    context: RunnerShutdownContext,
) => void | Promise<void>;

export type RunnerSdk = {
    readonly workloads: RunnerWorkloads;
    readonly secrets: RunnerSecrets;
    mount(mount: RunnerSdkMount): void;
    hijackConsoleLogging(): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
};
