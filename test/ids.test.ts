import { describe, expect, test } from "vitest";

import { hostMountKey, secretKey, workloadKey } from "../src/ids.ts";

describe("manifest keys", () => {
    test("accept authored manifest keys", () => {
        expect(workloadKey("api-worker_2")).toBe("api-worker_2");
        expect(secretKey("openai_api")).toBe("openai_api");
        expect(hostMountKey("model-cache")).toBe("model-cache");
    });

    test("reject manifest ids, tags, and invalid segments", () => {
        for (const value of ["", "Worker", "worker@revision", "worker/path", "-worker"]) {
            expect(() => workloadKey(value)).toThrow(/workload key/);
        }
    });
});
