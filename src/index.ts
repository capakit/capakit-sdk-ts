import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Server as HttpServer } from "node:http";

import {
    HostedMcpBridge,
} from "./mcp.ts";
import { createA2aHandler } from "./a2a.ts";
import { installHostConsoleLogging } from "./logging.ts";
import { RunnerSecretsImpl } from "./secrets.ts";
import type {
    EndpointPath,
    HostedBind,
    RunnerA2aMount,
    RunnerPresenceLifecycleContext,
    RunnerPresenceLifecycleHook,
    RunnerOaicMount,
    RunnerSdk,
    RunnerSdkMount,
    RunnerSdkOptions,
    RunnerShutdownHook,
    RunnerShutdownCause,
    RunnerSignal,
    RunnerWorkloads,
    RunnerSecrets,
} from "./public-types.ts";
import { loadRunnerEnv } from "./runner-env.ts";
import type { RunnerEnv } from "./runner-env.ts";
import {
    closeServer,
    createHostedServer,
    listen,
    parseBind,
    removeSocket,
} from "./transport.ts";
import { RunnerWorkloadsImpl } from "./workloads.ts";

export * from "./public-types.ts";
export { createA2aHandler } from "./a2a.ts";

type MountedHttpTransport = {
    endpoint: EndpointPath;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    handleRequest: (request: Request) => Promise<Response>;
};

class HostedRunnerSdk implements RunnerSdk {
    readonly workloads: RunnerWorkloads;
    readonly secrets: RunnerSecrets;

    private readonly bind: HostedBind;
    private readonly env: RunnerEnv;
    private readonly initialParentPid: number;
    private readonly runnerHostPid?: number;
    private readonly onPresenceStart?: RunnerPresenceLifecycleHook;
    private readonly onShutdown?: RunnerShutdownHook;
    private readonly mountedTransports = new Map<string, MountedHttpTransport>();
    private server: HttpServer | null = null;
    private stopPromise: Promise<void> | null = null;
    private parentMonitor?: ReturnType<typeof setInterval>;
    private orphanExitTimer?: ReturnType<typeof setTimeout>;
    private sigintHandler?: () => void;
    private sigtermHandler?: () => void;
    private restoreConsoleLogging?: () => void;

    constructor(options: RunnerSdkOptions = {}) {
        this.env = loadRunnerEnv();
        this.initialParentPid = currentParentPid();
        this.runnerHostPid = this.env.runnerHostPid;
        this.bind = parseBind(options.bind ?? this.env.managedIngressBind);
        this.onPresenceStart = options.onPresenceStart;
        this.onShutdown = options.onShutdown;
        this.workloads = new RunnerWorkloadsImpl(this.env);
        this.secrets = new RunnerSecretsImpl(this.env);
    }

    mount(mount: RunnerSdkMount): void {
        switch (mount.protocol) {
            case "mcp":
                this.mountHttpTransport(this.mcpServerTransport(mount));
                return;
            case "oaic":
                this.mountHttpTransport(
                    this.runnerHttpHandlerTransport(
                        "oaic",
                        mount.endpoint,
                        mount.handler,
                    ),
                );
                return;
            case "a2a":
                this.mountHttpTransport(this.a2aTransport(mount));
                return;
        }
    }

    hijackConsoleLogging(): () => void {
        this.restoreConsoleLogging?.();
        const restore = installHostConsoleLogging();
        this.restoreConsoleLogging = () => {
            restore();
            this.restoreConsoleLogging = undefined;
        };
        return this.restoreConsoleLogging;
    }

    async start(): Promise<void> {
        if (this.server) {
            return;
        }
        for (const mount of this.mountedTransports.values()) {
            await mount.start?.();
        }
        await this.onPresenceStart?.(this.lifecycleContext());
        const server = createHostedServer((request) => this.handleRequest(request));
        await listen(server, this.bind);
        this.server = server;
        this.installSignalHandlers();
        this.installParentMonitor();
        console.log(
            `[@capakit/sdk] workload=${this.env.workloadMid ?? "unknown"} listening`,
        );
    }

    async stop(): Promise<void> {
        return this.stopWithCause({ kind: "stop" });
    }

    private async stopWithCause(cause: RunnerShutdownCause): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }
        this.stopPromise = this.stopInner(cause).finally(() => {
            this.stopPromise = null;
        });
        return this.stopPromise;
    }

    private async stopInner(cause: RunnerShutdownCause): Promise<void> {
        this.removeSignalHandlers();
        this.removeParentMonitor();
        let hookError: unknown;
        try {
            await this.onShutdown?.({
                ...this.lifecycleContext(),
                cause,
            });
        } catch (error) {
            hookError = error;
        }
        const server = this.server;
        this.server = null;
        try {
            if (server) {
                await closeServer(server);
            }
            await this.workloads.close();
            await this.secrets.close();
            await Promise.all(
                Array.from(this.mountedTransports.values()).map(async (mount) => {
                    await mount.stop?.();
                }),
            );
        } finally {
            this.restoreConsoleLogging?.();
            if (this.bind.kind === "unix") {
                await removeSocket(this.bind.path);
            }
        }
        if (hookError) {
            throw hookError;
        }
    }

    private lifecycleContext(): RunnerPresenceLifecycleContext {
        return {
            presenceId: this.env.presenceId,
            workloadMid: this.env.workloadMid,
        };
    }

    private installSignalHandlers(): void {
        if (this.sigintHandler || this.sigtermHandler) {
            return;
        }
        this.sigintHandler = () => {
            void this.handleSignal("SIGINT");
        };
        this.sigtermHandler = () => {
            void this.handleSignal("SIGTERM");
        };
        process.once("SIGINT", this.sigintHandler);
        process.once("SIGTERM", this.sigtermHandler);
    }

    private removeSignalHandlers(): void {
        if (this.sigintHandler) {
            process.off("SIGINT", this.sigintHandler);
            this.sigintHandler = undefined;
        }
        if (this.sigtermHandler) {
            process.off("SIGTERM", this.sigtermHandler);
            this.sigtermHandler = undefined;
        }
    }

    private installParentMonitor(): void {
        if (
            this.parentMonitor ||
            (this.initialParentPid <= 1 && runningInContainer())
        ) {
            return;
        }
        this.parentMonitor = setInterval(() => {
            if (this.runnerHostPid && !processExists(this.runnerHostPid)) {
                void this.handleParentExit();
                return;
            }
            if (currentParentPid() === 1) {
                void this.handleParentExit();
            }
        }, 5000);
        this.parentMonitor.unref?.();
    }

    private removeParentMonitor(): void {
        if (!this.parentMonitor) {
            return;
        }
        clearInterval(this.parentMonitor);
        this.parentMonitor = undefined;
    }

    private async handleParentExit(): Promise<void> {
        if (this.stopPromise) {
            return;
        }
        this.removeParentMonitor();
        console.error(
            `[@capakit/sdk] parent process exited; shutting down orphaned workload pid=${process.pid}`,
        );
        this.orphanExitTimer = setTimeout(() => {
            process.exit(0);
        }, 2000);
        try {
            await this.stopWithCause({
                kind: "orphaned",
                initialParentPid: this.initialParentPid,
            });
            this.clearOrphanExitTimer();
            process.exit(0);
        } catch (error) {
            this.clearOrphanExitTimer();
            console.error("[@capakit/sdk] orphan shutdown failed", error);
            process.exit(1);
        }
    }

    private clearOrphanExitTimer(): void {
        if (!this.orphanExitTimer) {
            return;
        }
        clearTimeout(this.orphanExitTimer);
        this.orphanExitTimer = undefined;
    }

    private async handleSignal(signal: RunnerSignal): Promise<void> {
        try {
            await this.stopWithCause({
                kind: "signal",
                signal,
            });
            process.exit(0);
        } catch (error) {
            console.error(
                `[@capakit/sdk] shutdown failed for signal=${signal}`,
                error,
            );
            process.exit(1);
        }
    }

    private async handleRequest(request: Request): Promise<Response> {
        try {
            const requestPath = new URL(request.url).pathname;
            const transport = this.resolveMountedTransport(requestPath);
            if (!transport) {
                return new Response(JSON.stringify({ error: "not found" }), {
                    status: 404,
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                    },
                });
            }

            return await transport.handleRequest(request);
        } catch (error) {
            return new Response(
                JSON.stringify({
                    error: error instanceof Error ? error.message : "internal error",
                }),
                {
                    status: 500,
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                    },
                },
            );
        }
    }

    private mountHttpTransport(transport: MountedHttpTransport): void {
        if (this.mountedTransports.has(transport.endpoint)) {
            throw new Error(`runner SDK endpoint \`${transport.endpoint}\` is already mounted`);
        }
        this.mountedTransports.set(transport.endpoint, transport);
    }

    private mcpServerTransport(mount: HostedRunnerSdkMcpMount): MountedHttpTransport {
        const mcpBridge = new HostedMcpBridge();
        mcpBridge.mount(mount.server);
        return {
            endpoint: mount.endpoint,
            start: () => mcpBridge.start(),
            stop: () => mcpBridge.stop(),
            handleRequest: (request) => mcpBridge.handleRequest(request),
        };
    }

    private a2aTransport(mount: RunnerA2aMount): MountedHttpTransport {
        return this.runnerHttpHandlerTransport(
            "a2a",
            mount.endpoint,
            createA2aHandler({
                agentCard: mount.agentCard,
                executor: mount.executor,
                taskStore: mount.taskStore,
            }),
        );
    }

    private runnerHttpHandlerTransport(
        protocol: RunnerOaicMount["protocol"] | RunnerA2aMount["protocol"],
        endpoint: EndpointPath,
        handler: RunnerOaicMount["handler"],
    ): MountedHttpTransport {
        return {
            endpoint,
            handleRequest: async (request) => {
                return await handler(
                    request,
                    {
                        ...this.lifecycleContext(),
                        protocol,
                        endpoint,
                    },
                );
            },
        };
    }

    private resolveMountedTransport(path: string): MountedHttpTransport | null {
        const matches = Array.from(this.mountedTransports.values())
            .filter((mount) => pathMatchesEndpoint(path, mount.endpoint))
            .sort((left, right) => right.endpoint.length - left.endpoint.length);
        return matches[0] ?? null;
    }
}

export function createRunnerSdk(options: RunnerSdkOptions = {}): RunnerSdk {
    return new HostedRunnerSdk(options);
}

type HostedRunnerSdkMcpMount = Extract<RunnerSdkMount, { protocol: "mcp" }>;

function currentParentPid(): number {
    try {
        const output = execFileSync(
            "ps",
            ["-o", "ppid=", "-p", String(process.pid)],
            { encoding: "utf8" },
        ).trim();
        const pid = Number.parseInt(output, 10);
        if (Number.isFinite(pid)) {
            return pid;
        }
    } catch {
    }
    return process.ppid;
}

function runningInContainer(): boolean {
    return Boolean(
        process.env.container ||
            process.env.KUBERNETES_SERVICE_HOST ||
            existsSync("/.dockerenv"),
    );
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function pathMatchesEndpoint(path: string, endpoint: EndpointPath): boolean {
    return path === endpoint || path.startsWith(`${endpoint}/`);
}
