import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Server as HttpServer } from "node:http";

import {
    WORKLOAD_SDK_CLIENT_LIFECYCLE,
    type WorkloadSdkClientCleanup,
} from "./client-lifecycle.ts";
import { installHostConsoleLogging } from "./logging.ts";
import { HostMountsImpl } from "./mounts.ts";
import { WorkloadSecretsImpl } from "./secrets.ts";
import type {
    EndpointPath,
    HostedBind,
    WorkloadPresenceLifecycleContext,
    WorkloadPresenceLifecycleHook,
    WorkloadSdk,
    WorkloadSdkMount,
    WorkloadSdkOptions,
    WorkloadShutdownHook,
    WorkloadShutdownCause,
    ShutdownSignal,
    HostMounts,
    WorkloadConnections,
    WorkloadSecrets,
} from "./public-types.ts";
import { loadWorkloadEnv } from "./workload-env.ts";
import type { WorkloadEnv } from "./workload-env.ts";
import {
    closeServer,
    createHostedServer,
    listen,
    parseBind,
    removeSocket,
} from "./transport.ts";
import { WorkloadConnectionsImpl } from "./workloads.ts";

export type * from "./public-types.ts";
export {
    endpointPath,
    hostMountMid,
    secretMid,
    workloadMid,
} from "./ids.ts";

type MountedHttpTransport = {
    endpoint: EndpointPath;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
    handleRequest: (request: Request) => Promise<Response>;
};

class HostedWorkloadSdk implements WorkloadSdk {
    readonly workloads: WorkloadConnections;
    readonly secrets: WorkloadSecrets;
    readonly mounts: HostMounts;

    private readonly bind: HostedBind;
    private readonly env: WorkloadEnv;
    private readonly initialParentPid: number;
    private readonly workloadHostPid?: number;
    private readonly onPresenceStart?: WorkloadPresenceLifecycleHook;
    private readonly onShutdown?: WorkloadShutdownHook;
    private readonly mountedTransports = new Map<string, MountedHttpTransport>();
    private readonly clientCleanups = new Set<WorkloadSdkClientCleanup>();
    private server: HttpServer | null = null;
    private stopPromise: Promise<void> | null = null;
    private parentMonitor?: ReturnType<typeof setInterval>;
    private orphanExitTimer?: ReturnType<typeof setTimeout>;
    private sigintHandler?: () => void;
    private sigtermHandler?: () => void;
    private restoreConsoleLogging?: () => void;

    constructor(options: WorkloadSdkOptions = {}) {
        this.env = loadWorkloadEnv();
        this.initialParentPid = currentParentPid();
        this.workloadHostPid = this.env.workloadHostPid;
        this.bind = parseBind(options.bind ?? this.env.workloadIngressBind);
        this.onPresenceStart = options.onPresenceStart;
        this.onShutdown = options.onShutdown;
        this.workloads = new WorkloadConnectionsImpl(this.env);
        this.secrets = new WorkloadSecretsImpl(this.env);
        this.mounts = new HostMountsImpl(this.env);
    }

    mount(mount: WorkloadSdkMount): void {
        switch (mount.protocol) {
            case "http":
            case "oaic":
            case "mcp":
            case "a2a":
                this.mountHttpTransport(
                    this.workloadHttpHandlerTransport(mount),
                );
                return;
        }
    }

    [WORKLOAD_SDK_CLIENT_LIFECYCLE](cleanup: WorkloadSdkClientCleanup): void {
        this.clientCleanups.add(cleanup);
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
        const server = createHostedServer(
            (request) => this.handleRequest(request),
        );
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

    private async stopWithCause(cause: WorkloadShutdownCause): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }
        this.stopPromise = this.stopInner(cause).finally(() => {
            this.stopPromise = null;
        });
        return this.stopPromise;
    }

    private async stopInner(cause: WorkloadShutdownCause): Promise<void> {
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
            await this.closeRegisteredClients();
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

    private async closeRegisteredClients(): Promise<void> {
        const cleanups = Array.from(this.clientCleanups);
        this.clientCleanups.clear();
        await Promise.all(cleanups.map((cleanup) => cleanup()));
    }

    private lifecycleContext(): WorkloadPresenceLifecycleContext {
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
            if (this.workloadHostPid && !processExists(this.workloadHostPid)) {
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

    private async handleSignal(signal: ShutdownSignal): Promise<void> {
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
            throw new Error(`workload SDK endpoint \`${transport.endpoint}\` is already mounted`);
        }
        this.mountedTransports.set(transport.endpoint, transport);
    }

    private workloadHttpHandlerTransport(mount: WorkloadSdkMount): MountedHttpTransport {
        return {
            endpoint: mount.endpoint,
            start: mount.start,
            stop: mount.stop,
            handleRequest: async (request) => {
                return await mount.handler(
                    request,
                    {
                        ...this.lifecycleContext(),
                        protocol: mount.protocol,
                        endpoint: mount.endpoint,
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

export function createWorkloadSdk(options: WorkloadSdkOptions = {}): WorkloadSdk {
    return new HostedWorkloadSdk(options);
}

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
