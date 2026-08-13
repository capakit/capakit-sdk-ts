import { describe, expect, test } from "vitest";

import { HostMountsImpl } from "../src/mounts.ts";
import { hostMountKey } from "../src/ids.ts";

describe("HostMountsImpl", () => {
    test("gets and lists configured host mounts", () => {
        const mounts = new HostMountsImpl({
            connectedWorkloads: [],
            mounts: [
                {
                    key: hostMountKey("docs"),
                    path: "/Users/me/docs",
                    access: "read_only",
                },
            ],
            workloadIngressBind: "tcp:127.0.0.1:4100",
        });

        expect(mounts.get(hostMountKey("docs"))).toEqual({
            key: "docs",
            path: "/Users/me/docs",
            access: "read_only",
        });
        expect(mounts.get(hostMountKey("missing"))).toBeUndefined();
        expect(mounts.list()).toEqual([
            {
                key: "docs",
                path: "/Users/me/docs",
                access: "read_only",
            },
        ]);
    });
});
