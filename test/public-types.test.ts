import { describe, expect, test } from "vitest";

import { endpointPath } from "../src/public-types.ts";

describe("endpointPath", () => {
    test("normalizes relative endpoint paths", () => {
        expect(endpointPath("health")).toBe("/health");
    });

    test("preserves absolute endpoint paths", () => {
        expect(endpointPath("/health")).toBe("/health");
    });

    test("rejects empty endpoint paths", () => {
        expect(() => endpointPath("")).toThrow(/must not be empty/);
    });
});
