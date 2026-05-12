import { describe, expect, test } from "vitest";

import {
    loadConnectedWorkloadConfigs,
    loadRunnerEnv,
    requireRunnerBridgeBind,
    RUNNER_ENV_KEYS,
} from "../src/runner-env.ts";

describe("loadRunnerEnv", () => {
    test("loads required bind, optional identity, and connected workloads", () => {
        const env = loadRunnerEnv({
            [RUNNER_ENV_KEYS.connectedWorkloads]: JSON.stringify([
                {
                    workloadMid: "mid:capability/workload",
                    endpoint: "chat",
                    protocol: "oaic",
                    bind: "tcp:127.0.0.1:4100",
                },
            ]),
            [RUNNER_ENV_KEYS.managedIngressBind]: "unix:/tmp/capakit.sock",
            [RUNNER_ENV_KEYS.runnerBridgeBind]: "tcp:127.0.0.1:4200",
            [RUNNER_ENV_KEYS.runnerSid]: "sid:runner/dev",
            [RUNNER_ENV_KEYS.presenceId]: "presence-1",
            [RUNNER_ENV_KEYS.workloadMid]: "mid:self/workload",
        });

        expect(env.managedIngressBind).toBe("unix:/tmp/capakit.sock");
        expect(env.runnerBridgeBind).toBe("tcp:127.0.0.1:4200");
        expect(env.runnerSid).toBe("sid:runner/dev");
        expect(env.presenceId).toBe("presence-1");
        expect(env.workloadMid).toBe("mid:self/workload");
        expect(env.connectedWorkloads).toEqual([
            {
                workloadMid: "mid:capability/workload",
                endpoint: "/chat",
                protocol: "oaic",
                bind: "tcp:127.0.0.1:4100",
            },
        ]);
    });

    test("requires managed ingress bind", () => {
        expect(() => loadRunnerEnv({})).toThrow(/CAPAKIT_RUNNER_MANAGED_INGRESS_BIND/);
    });
});

describe("loadConnectedWorkloadConfigs", () => {
    test("defaults to no connected workloads", () => {
        expect(loadConnectedWorkloadConfigs({})).toEqual([]);
    });

    test("rejects unsupported protocols", () => {
        expect(() => loadConnectedWorkloadConfigs({
            [RUNNER_ENV_KEYS.connectedWorkloads]: JSON.stringify([
                {
                    workloadMid: "mid:capability/workload",
                    endpoint: "/chat",
                    protocol: "smtp",
                    bind: "tcp:127.0.0.1:4100",
                },
            ]),
        })).toThrow(/unsupported runner protocol/);
    });
});

describe("requireRunnerBridgeBind", () => {
    test("returns configured bridge bind", () => {
        expect(requireRunnerBridgeBind({
            connectedWorkloads: [],
            managedIngressBind: "tcp:127.0.0.1:4100",
            runnerBridgeBind: "tcp:127.0.0.1:4200",
        })).toBe("tcp:127.0.0.1:4200");
    });

    test("rejects missing bridge bind", () => {
        expect(() => requireRunnerBridgeBind({
            connectedWorkloads: [],
            managedIngressBind: "tcp:127.0.0.1:4100",
        })).toThrow(/CAPAKIT_RUNNER_BRIDGE_BIND/);
    });
});
