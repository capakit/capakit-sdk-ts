import { describe, expect, test } from "vitest";

import { endpointPath, workloadKey } from "../src/ids.ts";
import { WorkloadConnectionsImpl } from "../src/workloads.ts";

describe("WorkloadConnectionsImpl", () => {
    test("reports unavailable authored workload endpoints", () => {
        const workloads = new WorkloadConnectionsImpl({
            connectedWorkloads: [],
            mounts: [],
            workloadIngressBind: "tcp:127.0.0.1:4100",
        });

        expect(() => workloads.endpoint(
            workloadKey("worker"),
            endpointPath("/rpc"),
        )).toThrow(/worker\/rpc.*not available/);
    });
});
