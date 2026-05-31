import { describe, expect, test } from "vitest";

import {
    RUNNER_SDK_CLIENT_LIFECYCLE,
    type RunnerSdkClientCleanup,
} from "../src/client-lifecycle.ts";
import { createRunnerSdk } from "../src/index.ts";
import type { RunnerSdk } from "../src/public-types.ts";
import { RUNNER_ENV_KEYS } from "../src/runner-env.ts";

type InternalRunnerSdk = RunnerSdk & {
    [RUNNER_SDK_CLIENT_LIFECYCLE]?: (cleanup: RunnerSdkClientCleanup) => void;
};

describe("runner SDK client lifecycle", () => {
    test("stop closes registered SDK clients once", async () => {
        const restoreEnv = withRunnerEnv();
        try {
            const sdk = createRunnerSdk() as InternalRunnerSdk;
            let closed = 0;
            sdk[RUNNER_SDK_CLIENT_LIFECYCLE]?.(() => {
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

function withRunnerEnv(): () => void {
    const previous = {
        managedIngressBind: process.env[RUNNER_ENV_KEYS.managedIngressBind],
        runnerBridgeBind: process.env[RUNNER_ENV_KEYS.runnerBridgeBind],
    };
    process.env[RUNNER_ENV_KEYS.managedIngressBind] = "tcp:127.0.0.1:4100";
    process.env[RUNNER_ENV_KEYS.runnerBridgeBind] = "tcp:127.0.0.1:4101";
    return () => {
        restoreEnvValue(RUNNER_ENV_KEYS.managedIngressBind, previous.managedIngressBind);
        restoreEnvValue(RUNNER_ENV_KEYS.runnerBridgeBind, previous.runnerBridgeBind);
    };
}

function restoreEnvValue(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
}
