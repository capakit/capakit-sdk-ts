import { describe, expect, test } from "vitest";

import {
    loadConnectedWorkloadConfigs,
    loadHostMountConfigs,
    loadWorkloadEnv,
    requireWorkloadBridgeBind,
    WORKLOAD_ENV_KEYS,
} from "../src/workload-env.ts";

describe("loadWorkloadEnv", () => {
    test("loads required bind, optional identity, and connected workloads", () => {
        const env = loadWorkloadEnv({
            [WORKLOAD_ENV_KEYS.connectedWorkloads]: JSON.stringify([
                {
                    workloadKey: "worker",
                    endpoint: "chat",
                    protocol: "http",
                    bind: "tcp:127.0.0.1:4100",
                },
            ]),
            [WORKLOAD_ENV_KEYS.workloadIngressBind]: "unix:/tmp/capakit.sock",
            [WORKLOAD_ENV_KEYS.workloadBridgeBind]: "tcp:127.0.0.1:4200",
            [WORKLOAD_ENV_KEYS.presenceId]: "presence-1",
            [WORKLOAD_ENV_KEYS.workloadKey]: "self",
            [WORKLOAD_ENV_KEYS.mounts]: JSON.stringify({
                docs: {
                    key: "docs",
                    path: "/Users/me/docs",
                    access: "read_write",
                },
            }),
        });

        expect(env.workloadIngressBind).toBe("unix:/tmp/capakit.sock");
        expect(env.workloadBridgeBind).toBe("tcp:127.0.0.1:4200");
        expect(env.presenceId).toBe("presence-1");
        expect(env.workloadKey).toBe("self");
        expect(env.mounts).toEqual([
            {
                key: "docs",
                path: "/Users/me/docs",
                access: "read_write",
            },
        ]);
        expect(env.connectedWorkloads).toEqual([
            {
                workloadKey: "worker",
                endpoint: "/chat",
                protocol: "http",
                bind: "tcp:127.0.0.1:4100",
            },
        ]);
    });

    test("requires managed ingress bind", () => {
        expect(() => loadWorkloadEnv({})).toThrow(/CAPAKIT_WORKLOAD_INGRESS_BIND/);
    });
});

describe("loadHostMountConfigs", () => {
    test("defaults to no host mounts", () => {
        expect(loadHostMountConfigs({})).toEqual([]);
    });

    test("loads host mount configs", () => {
        expect(loadHostMountConfigs({
            [WORKLOAD_ENV_KEYS.mounts]: JSON.stringify({
                docs: {
                    key: "docs",
                    path: "/Users/me/docs",
                    access: "read_only",
                },
            }),
        })).toEqual([
            {
                key: "docs",
                path: "/Users/me/docs",
                access: "read_only",
            },
        ]);
    });

    test("rejects unsupported access modes", () => {
        expect(() => loadHostMountConfigs({
            [WORKLOAD_ENV_KEYS.mounts]: JSON.stringify({
                docs: {
                    key: "docs",
                    path: "/Users/me/docs",
                    access: "admin",
                },
            }),
        })).toThrow(/unsupported host mount access/);
    });
});

describe("loadConnectedWorkloadConfigs", () => {
    test("defaults to no connected workloads", () => {
        expect(loadConnectedWorkloadConfigs({})).toEqual([]);
    });

    test("rejects unsupported protocols", () => {
        expect(() => loadConnectedWorkloadConfigs({
            [WORKLOAD_ENV_KEYS.connectedWorkloads]: JSON.stringify([
                {
                    workloadKey: "worker",
                    endpoint: "/chat",
                    protocol: "smtp",
                    bind: "tcp:127.0.0.1:4100",
                },
            ]),
        })).toThrow(/unsupported endpoint protocol/);
    });
});

describe("requireWorkloadBridgeBind", () => {
    test("returns configured bridge bind", () => {
        expect(requireWorkloadBridgeBind({
            connectedWorkloads: [],
            mounts: [],
            workloadIngressBind: "tcp:127.0.0.1:4100",
            workloadBridgeBind: "tcp:127.0.0.1:4200",
        })).toBe("tcp:127.0.0.1:4200");
    });

    test("rejects missing bridge bind", () => {
        expect(() => requireWorkloadBridgeBind({
            connectedWorkloads: [],
            mounts: [],
            workloadIngressBind: "tcp:127.0.0.1:4100",
        })).toThrow(/CAPAKIT_WORKLOAD_BRIDGE_BIND/);
    });
});
