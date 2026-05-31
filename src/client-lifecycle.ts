import type { RunnerSdk } from "./public-types.ts";

export type RunnerSdkClientCleanup = () => Promise<void> | void;

export const RUNNER_SDK_CLIENT_LIFECYCLE = Symbol.for(
    "@capakit/sdk/client-lifecycle",
);

type RunnerSdkClientLifecycle = {
    [RUNNER_SDK_CLIENT_LIFECYCLE](cleanup: RunnerSdkClientCleanup): void;
};

export function registerSdkClientCleanup(
    sdk: RunnerSdk,
    cleanup: RunnerSdkClientCleanup,
): void {
    const lifecycle = sdk as RunnerSdk & Partial<RunnerSdkClientLifecycle>;
    lifecycle[RUNNER_SDK_CLIENT_LIFECYCLE]?.(cleanup);
}

export function registerSdkCloseableClient(sdk: RunnerSdk, client: unknown): void {
    if (typeof client !== "object" || client === null) {
        return;
    }
    const close = (client as { close?: unknown }).close;
    if (typeof close === "function") {
        registerSdkClientCleanup(sdk, () => close.call(client));
    }
}
