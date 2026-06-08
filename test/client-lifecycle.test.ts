import { describe, expect, test } from "vitest";

import {
    WORKLOAD_SDK_CLIENT_LIFECYCLE,
    type WorkloadSdkClientCleanup,
} from "../src/client-lifecycle.ts";
import { endpointPath } from "../src/ids.ts";
import { createWorkloadSdk } from "../src/index.ts";
import type { WorkloadSdk } from "../src/public-types.ts";
import { WORKLOAD_ENV_KEYS } from "../src/workload-env.ts";

type InternalWorkloadSdk = WorkloadSdk & {
    [WORKLOAD_SDK_CLIENT_LIFECYCLE]?: (cleanup: WorkloadSdkClientCleanup) => void;
    handleRequest(request: Request): Promise<Response>;
};

describe("workload SDK client lifecycle", () => {
    test("stop closes registered SDK clients once", async () => {
        const restoreEnv = withWorkloadEnv();
        try {
            const sdk = createWorkloadSdk() as InternalWorkloadSdk;
            let closed = 0;
            sdk[WORKLOAD_SDK_CLIENT_LIFECYCLE]?.(() => {
                closed += 1;
            });

            await sdk.stop();
            await sdk.stop();

            expect(closed).toBe(1);
        } finally {
            restoreEnv();
        }
    });
});

describe("workload SDK HTTP mounting", () => {
    test("root endpoint handles subpaths", async () => {
        const restoreEnv = withWorkloadEnv();
        try {
            const sdk = createWorkloadSdk() as InternalWorkloadSdk;
            sdk.mount({
                protocol: "http",
                endpoint: endpointPath("/"),
                handler: (request) =>
                    Response.json({ path: new URL(request.url).pathname }),
            });

            const response = await sdk.handleRequest(new Request("http://capakit.local/health"));

            await expect(response.json()).resolves.toEqual({ path: "/health" });
        } finally {
            restoreEnv();
        }
    });

    test("mounted endpoint handlers receive app-relative paths", async () => {
        const restoreEnv = withWorkloadEnv();
        try {
            const sdk = createWorkloadSdk() as InternalWorkloadSdk;
            sdk.mount({
                protocol: "http",
                endpoint: endpointPath("/http"),
                handler: (request, context) => {
                    const url = new URL(request.url);
                    return Response.json({
                        path: url.pathname,
                        search: url.search,
                        endpoint: context.endpoint,
                    });
                },
            });

            const response = await sdk.handleRequest(
                new Request("http://capakit.local/http/checks/readiness?probe=1"),
            );

            await expect(response.json()).resolves.toEqual({
                path: "/checks/readiness",
                search: "?probe=1",
                endpoint: "/http",
            });
        } finally {
            restoreEnv();
        }
    });
});

function withWorkloadEnv(): () => void {
    const previous = {
        workloadIngressBind: process.env[WORKLOAD_ENV_KEYS.workloadIngressBind],
        workloadBridgeBind: process.env[WORKLOAD_ENV_KEYS.workloadBridgeBind],
    };
    process.env[WORKLOAD_ENV_KEYS.workloadIngressBind] = "tcp:127.0.0.1:4100";
    process.env[WORKLOAD_ENV_KEYS.workloadBridgeBind] = "tcp:127.0.0.1:4101";
    return () => {
        restoreEnvValue(WORKLOAD_ENV_KEYS.workloadIngressBind, previous.workloadIngressBind);
        restoreEnvValue(WORKLOAD_ENV_KEYS.workloadBridgeBind, previous.workloadBridgeBind);
    };
}

function restoreEnvValue(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
}
