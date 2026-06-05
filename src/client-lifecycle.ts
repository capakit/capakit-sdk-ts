import type { WorkloadSdk } from "./public-types.ts";

export type WorkloadSdkClientCleanup = () => Promise<void> | void;

export const WORKLOAD_SDK_CLIENT_LIFECYCLE = Symbol.for(
    "@capakit/sdk/client-lifecycle",
);

type WorkloadSdkClientLifecycle = {
    [WORKLOAD_SDK_CLIENT_LIFECYCLE](cleanup: WorkloadSdkClientCleanup): void;
};

export function registerSdkClientCleanup(
    sdk: WorkloadSdk,
    cleanup: WorkloadSdkClientCleanup,
): void {
    const lifecycle = sdk as WorkloadSdk & Partial<WorkloadSdkClientLifecycle>;
    lifecycle[WORKLOAD_SDK_CLIENT_LIFECYCLE]?.(cleanup);
}

export function registerSdkCloseableClient(sdk: WorkloadSdk, client: unknown): void {
    if (typeof client !== "object" || client === null) {
        return;
    }
    const close = (client as { close?: unknown }).close;
    if (typeof close === "function") {
        registerSdkClientCleanup(sdk, () => close.call(client));
    }
}
