import {
    endpointPath,
    hostMountKey,
    workloadKey,
} from "./ids.ts";
import type {
    EndpointPath,
    HostMount,
    HostedBindValue,
    PresenceId,
    EndpointProtocol,
    WorkloadKey,
} from "./public-types.ts";
import { normalizeMountAccess } from "./mounts.ts";

export const WORKLOAD_ENV_KEYS = {
    connectedWorkloads: "CAPAKIT_CONNECTED_WORKLOADS",
    workloadIngressBind: "CAPAKIT_WORKLOAD_INGRESS_BIND",
    workloadHostPid: "CAPAKIT_WORKLOAD_HOST_PID",
    workloadBridgeBind: "CAPAKIT_WORKLOAD_BRIDGE_BIND",
    presenceId: "CAPAKIT_PRESENCE_ID",
    workloadKey: "CAPAKIT_WORKLOAD_KEY",
    mounts: "CAPAKIT_MOUNTS_JSON",
} as const;

export type WorkloadEnv = {
    connectedWorkloads: HostedWorkloadConnectionConfig[];
    mounts: HostMount[];
    workloadIngressBind: HostedBindValue;
    workloadHostPid?: number;
    workloadBridgeBind?: HostedBindValue;
    presenceId?: PresenceId;
    workloadKey?: WorkloadKey;
};

export type HostedWorkloadConnectionConfig = {
    workloadKey: WorkloadKey;
    endpoint: EndpointPath;
    protocol: EndpointProtocol;
    bind: HostedBindValue;
};

export function loadWorkloadEnv(env: NodeJS.ProcessEnv = process.env): WorkloadEnv {
    return {
        connectedWorkloads: loadConnectedWorkloadConfigs(env),
        mounts: loadHostMountConfigs(env),
        workloadIngressBind: requiredEnv(env, WORKLOAD_ENV_KEYS.workloadIngressBind),
        workloadHostPid: optionalPositiveInt(env[WORKLOAD_ENV_KEYS.workloadHostPid]),
        workloadBridgeBind: env[WORKLOAD_ENV_KEYS.workloadBridgeBind],
        presenceId: optionalPresenceId(env[WORKLOAD_ENV_KEYS.presenceId]),
        workloadKey: optionalWorkloadKey(env[WORKLOAD_ENV_KEYS.workloadKey]),
    };
}

export function loadConnectedWorkloadConfigs(
    env: NodeJS.ProcessEnv = process.env,
): HostedWorkloadConnectionConfig[] {
    const raw = env[WORKLOAD_ENV_KEYS.connectedWorkloads];
    if (!raw) {
        return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`${WORKLOAD_ENV_KEYS.connectedWorkloads} must be a JSON array`);
    }
    return parsed.map((value) => normalizeConnectedWorkload(value));
}

export function loadHostMountConfigs(
    env: NodeJS.ProcessEnv = process.env,
): HostMount[] {
    const raw = env[WORKLOAD_ENV_KEYS.mounts];
    if (!raw) {
        return [];
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${WORKLOAD_ENV_KEYS.mounts} must be a JSON object`);
    }
    return Object.entries(parsed).map(([key, value]) =>
        normalizeHostMountConfig(key, value),
    );
}

export function requireWorkloadBridgeBind(env: WorkloadEnv): HostedBindValue {
    if (!env.workloadBridgeBind) {
        throw new Error(`${WORKLOAD_ENV_KEYS.workloadBridgeBind} is required`);
    }
    return env.workloadBridgeBind;
}

function normalizeHostMountConfig(key: string, value: unknown): HostMount {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("host mount entry must be an object");
    }
    const record = value as Record<string, unknown>;
    const mountKey = stringField(record, "key");
    if (mountKey !== key) {
        throw new Error(`host mount entry key \`${key}\` does not match key \`${mountKey}\``);
    }
    return {
        key: hostMountKey(mountKey),
        path: stringField(record, "path"),
        access: normalizeMountAccess(record.access),
    };
}

function normalizeConnectedWorkload(value: unknown): HostedWorkloadConnectionConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("connected workload entry must be an object");
    }
    const record = value as Record<string, unknown>;
    return {
        workloadKey: workloadKey(stringField(record, "workloadKey")),
        endpoint: endpointPath(stringField(record, "endpoint")),
        protocol: protocolField(record),
        bind: stringField(record, "bind"),
    };
}

function protocolField(record: Record<string, unknown>): EndpointProtocol {
    const protocol = stringField(record, "protocol");
    switch (protocol) {
        case "http":
        case "mcp":
        case "oaic":
        case "a2a":
            return protocol;
        default:
            throw new Error(`unsupported endpoint protocol \`${protocol}\``);
    }
}

function optionalPresenceId(value: string | undefined): PresenceId | undefined {
    return value as PresenceId | undefined;
}

function optionalWorkloadKey(value: string | undefined): WorkloadKey | undefined {
    return value ? workloadKey(value) : undefined;
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
