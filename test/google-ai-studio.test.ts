import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

import {
    RUNNER_SDK_CLIENT_LIFECYCLE,
    type RunnerSdkClientCleanup,
} from "../src/client-lifecycle.ts";
import { endpointPath, workloadMid } from "../src/ids.ts";
import { createGoogleAiStudioClient } from "../src/google-ai-studio.ts";
import type {
    EndpointPath,
    HostedBind,
    RunnerMounts,
    RunnerSdk,
    RunnerSdkMount,
    RunnerSecrets,
    RunnerWorkloads,
} from "../src/public-types.ts";
import {
    closeServer,
    createHostedServer,
    listen,
} from "../src/transport.ts";

const UPSTREAM_PATH_HEADER = "x-capakit-external-llm-upstream-path";

describe("createGoogleAiStudioClient", () => {
    test("routes genai requests through the workload endpoint and restores fetch", async () => {
        const originalFetch = globalThis.fetch;
        let observedRequest: {
            path: string;
            upstreamPath: string | null;
            apiKey: string | null;
            body: unknown;
        } | undefined;
        const server = createHostedServer(async (request) => {
            const url = new URL(request.url);
            observedRequest = {
                path: `${url.pathname}${url.search}`,
                upstreamPath: request.headers.get(UPSTREAM_PATH_HEADER),
                apiKey: request.headers.get("x-goog-api-key"),
                body: await request.json(),
            };
            return Response.json({
                candidates: [
                    {
                        content: {
                            parts: [{ text: "ok" }],
                            role: "model",
                        },
                        finishReason: "STOP",
                    },
                ],
                modelVersion: "test",
            });
        });
        await listen(server, { kind: "tcp", host: "127.0.0.1", port: nextPort() });
        const sdk = new TestRunnerSdk(tcpBind(server), endpointPath("/google"));

        try {
            const client = await createGoogleAiStudioClient(
                sdk,
                workloadMid("google"),
                endpointPath("/google"),
            );

            const response = await client.models.generateContent({
                model: "gemini-2.5-flash",
                contents: "hi",
            });

            expect(response.text).toBe("ok");
            expect(observedRequest).toMatchObject({
                path: "/google/v1beta/models/gemini-2.5-flash:generateContent",
                upstreamPath: "/v1beta/models/gemini-2.5-flash:generateContent",
                apiKey: "capakit-local",
            });
            expect(globalThis.fetch).not.toBe(originalFetch);

            await sdk.stop();

            expect(globalThis.fetch).toBe(originalFetch);
        } finally {
            await sdk.stop();
            globalThis.fetch = originalFetch;
            await closeServer(server);
        }
    });

    test("keeps the fetch patch active until the last route is cleaned up", async () => {
        const originalFetch = globalThis.fetch;
        const first = new TestRunnerSdk(
            { kind: "tcp", host: "127.0.0.1", port: 1 },
            endpointPath("/google-a"),
        );
        const second = new TestRunnerSdk(
            { kind: "tcp", host: "127.0.0.1", port: 2 },
            endpointPath("/google-b"),
        );

        try {
            await createGoogleAiStudioClient(
                first,
                workloadMid("google-a"),
                endpointPath("/google-a"),
            );
            await createGoogleAiStudioClient(
                second,
                workloadMid("google-b"),
                endpointPath("/google-b"),
            );
            const patchedFetch = globalThis.fetch;

            await first.stop();

            expect(globalThis.fetch).toBe(patchedFetch);

            await second.stop();

            expect(globalThis.fetch).toBe(originalFetch);
        } finally {
            await first.stop();
            await second.stop();
            globalThis.fetch = originalFetch;
        }
    });
});

class TestRunnerSdk implements RunnerSdk {
    readonly workloads: RunnerWorkloads;
    readonly secrets: RunnerSecrets = {
        resolve: async () => {
            throw new Error("secrets are not used by this test");
        },
        close: async () => {},
    };
    readonly mounts: RunnerMounts = {
        get: () => undefined,
        list: () => [],
    };

    private readonly cleanups = new Set<RunnerSdkClientCleanup>();

    constructor(
        private readonly bind: HostedBind,
        private readonly endpoint: EndpointPath,
    ) {
        this.workloads = {
            workloads: [],
            endpoint: (workload, _endpoint, _options) => ({
                workloadMid: workload,
                endpoint: this.endpoint,
                protocol: "oaic",
                bind: this.bind,
            }),
            close: async () => {},
        };
    }

    mount(_mount: RunnerSdkMount): void {}

    hijackConsoleLogging(): () => void {
        return () => {};
    }

    async start(): Promise<void> {}

    async stop(): Promise<void> {
        const cleanups = Array.from(this.cleanups);
        this.cleanups.clear();
        await Promise.all(cleanups.map((cleanup) => cleanup()));
    }

    [RUNNER_SDK_CLIENT_LIFECYCLE](cleanup: RunnerSdkClientCleanup): void {
        this.cleanups.add(cleanup);
    }
}

function tcpBind(server: Server): HostedBind {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("expected TCP test server address");
    }
    return {
        kind: "tcp",
        host: "127.0.0.1",
        port: (address as AddressInfo).port,
    };
}

let portCursor = 34000 + (process.pid % 10000);

function nextPort(): number {
    return portCursor++;
}
