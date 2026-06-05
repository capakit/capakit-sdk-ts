import { describe, expect, test } from "vitest";

import { HostMountsImpl } from "../src/mounts.ts";
import { hostMountMid } from "../src/ids.ts";

describe("HostMountsImpl", () => {
    test("gets and lists configured host mounts", () => {
        const mounts = new HostMountsImpl({
            connectedWorkloads: [],
            mounts: [
                {
                    mid: hostMountMid("docs"),
                    path: "/Users/me/docs",
                    access: "read_only",
                },
            ],
            workloadIngressBind: "tcp:127.0.0.1:4100",
        });

        expect(mounts.get(hostMountMid("docs"))).toEqual({
            mid: "docs",
            path: "/Users/me/docs",
            access: "read_only",
        });
        expect(mounts.get(hostMountMid("missing"))).toBeUndefined();
        expect(mounts.list()).toEqual([
            {
                mid: "docs",
                path: "/Users/me/docs",
                access: "read_only",
            },
        ]);
    });
});
