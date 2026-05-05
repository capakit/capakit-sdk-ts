import {
    endpointPath,
    workloadMid,
} from "./public-types.ts";
import type {
    EndpointPath,
    HostedBindValue,
    RunnerProtocol,
    SessionId,
    WorkloadMid,
} from "./public-types.ts";

export const RUNNER_ENV_KEYS = {
    connectedWorkloads: "CAPAKIT_CONNECTED_WORKLOADS",
    managedIngressBind: "CAPAKIT_RUNNER_MANAGED_INGRESS_BIND",
    runnerHostBackend: "CAPAKIT_RUNNER_HOST_BACKEND",
    runnerHostPid: "CAPAKIT_RUNNER_HOST_PID",
    runnerBridgeBind: "CAPAKIT_RUNNER_BRIDGE_BIND",
    runnerSid: "CAPAKIT_RUNNER_SID",
    sessionId: "CAPAKIT_SESSION_ID",
    workloadMid: "CAPAKIT_WORKLOAD_MID",
} as const;

export type RunnerHostBackend =
    | "embedded"
    | "mac_os"
    | "mac_os_sandbox"
    | "windows"
    | "windows_sandbox"
    | "docker"
    | "vm"
    | "remote";

export type RunnerEnv = {
    connectedWorkloads: HostedWorkloadConnectionConfig[];
    managedIngressBind: HostedBindValue;
    runnerHostBackend?: RunnerHostBackend;
    runnerHostPid?: number;
    runnerBridgeBind?: HostedBindValue;
    runnerSid?: string;
    sessionId?: SessionId;
    workloadMid?: WorkloadMid;
};

export type HostedWorkloadConnectionConfig = {
    workloadMid: WorkloadMid;
    endpoint: EndpointPath;
    protocol: RunnerProtocol;
    bind: HostedBindValue;
};

export function loadRunnerEnv(env: NodeJS.ProcessEnv = process.env): RunnerEnv {
    return {
        connectedWorkloads: loadConnectedWorkloadConfigs(env),
        managedIngressBind: requiredEnv(env, RUNNER_ENV_KEYS.managedIngressBind),
        runnerHostBackend: optionalHostBackend(env[RUNNER_ENV_KEYS.runnerHostBackend]),
        runnerHostPid: optionalPositiveInt(env[RUNNER_ENV_KEYS.runnerHostPid]),
        runnerBridgeBind: env[RUNNER_ENV_KEYS.runnerBridgeBind],
        runnerSid: env[RUNNER_ENV_KEYS.runnerSid],
        sessionId: optionalSessionId(env[RUNNER_ENV_KEYS.sessionId]),
        workloadMid: optionalWorkloadMid(env[RUNNER_ENV_KEYS.workloadMid]),
    };
}

export function loadConnectedWorkloadConfigs(
    env: NodeJS.ProcessEnv = process.env,
): HostedWorkloadConnectionConfig[] {
    const raw = env[RUNNER_ENV_KEYS.connectedWorkloads];
    if (!raw) {
        return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`${RUNNER_ENV_KEYS.connectedWorkloads} must be a JSON array`);
    }
    return parsed.map((value) => normalizeConnectedWorkload(value));
}

export function requireRunnerBridgeBind(env: RunnerEnv): HostedBindValue {
    if (!env.runnerBridgeBind) {
        throw new Error(`${RUNNER_ENV_KEYS.runnerBridgeBind} is required`);
    }
    return env.runnerBridgeBind;
}

function normalizeConnectedWorkload(value: unknown): HostedWorkloadConnectionConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("connected workload entry must be an object");
    }
    const record = value as Record<string, unknown>;
    return {
        workloadMid: workloadMid(stringField(record, "workloadMid")),
        endpoint: endpointPath(stringField(record, "endpoint")),
        protocol: protocolField(record),
        bind: stringField(record, "bind"),
    };
}

function protocolField(record: Record<string, unknown>): RunnerProtocol {
    const protocol = stringField(record, "protocol");
    switch (protocol) {
        case "mcp":
        case "oaic":
        case "a2a":
            return protocol;
        default:
            throw new Error(`unsupported runner protocol \`${protocol}\``);
    }
}

function optionalHostBackend(value: string | undefined): RunnerHostBackend | undefined {
    return value as RunnerHostBackend | undefined;
}

function optionalSessionId(value: string | undefined): SessionId | undefined {
    return value as SessionId | undefined;
}

function optionalWorkloadMid(value: string | undefined): WorkloadMid | undefined {
    return value ? workloadMid(value) : undefined;
}

function optionalPositiveInt(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
    const value = env[key];
    if (!value) {
        throw new Error(`${key} is required`);
    }
    return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`expected string field \`${key}\``);
    }
    return value;
}
