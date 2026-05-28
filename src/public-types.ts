declare const CAPAKIT_BRAND: unique symbol;

type Brand<T, Name extends string> = T & {
    readonly [CAPAKIT_BRAND]: Name;
};

export type HostedBindValue = string;
export type PresenceId = string;
export type EndpointPath = Brand<string, "EndpointPath">;
export type WorkloadMid = Brand<string, "WorkloadMid">;
export type SecretMid = Brand<string, "SecretMid">;
export type HostMountMid = Brand<string, "HostMountMid">;
export type RunnerProtocol = "http" | "mcp" | "oaic" | "a2a";
export type HostMountAccess = "read_only" | "read_write";

export type HostedBind =
    | { kind: "unix"; path: string }
    | { kind: "tcp"; host: string; port: number }
    | { kind: "pipe"; name: string };

export declare function endpointPath(value: string): EndpointPath;
export declare function workloadMid(value: string): WorkloadMid;
export declare function secretMid(value: string): SecretMid;
export declare function hostMountMid(value: string): HostMountMid;

export type ClientOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

export type RunnerWorkloadConnection = {
    workloadMid: WorkloadMid;
    endpoint: EndpointPath;
    protocol: RunnerProtocol;
};

export type RunnerWorkloadEndpoint = RunnerWorkloadConnection & {
    bind: HostedBind;
};

export type RunnerWorkloads = {
    readonly workloads: ReadonlyArray<RunnerWorkloadConnection>;
    endpoint(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): RunnerWorkloadEndpoint;
    close(): Promise<void>;
};

export type RunnerSecrets = {
    resolve(secretMid: SecretMid): Promise<string>;
    close(): Promise<void>;
};

export type HostMount = {
    mid: HostMountMid;
    path: string;
    access: HostMountAccess;
};

export type RunnerMounts = {
    get(mountMid: HostMountMid): HostMount | undefined;
    list(): readonly HostMount[];
};

export type RunnerSdkOptions = {
    bind?: HostedBindValue;
    onPresenceStart?: RunnerPresenceLifecycleHook;
    onShutdown?: RunnerShutdownHook;
};

export type RunnerHttpHandlerContext = RunnerPresenceLifecycleContext & {
    protocol: RunnerProtocol;
    endpoint: EndpointPath;
};

export type RunnerHttpHandler = (
    request: Request,
    context: RunnerHttpHandlerContext,
) => Response | Promise<Response>;

export type RunnerHttpMount = {
    protocol: "http";
    endpoint: EndpointPath;
    handler: RunnerHttpHandler;
};

export type RunnerSdkMount = {
    protocol: RunnerProtocol;
    endpoint: EndpointPath;
    handler: RunnerHttpHandler;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
};

export type RunnerSignal = "SIGINT" | "SIGTERM";

export type RunnerPresenceLifecycleContext = {
    presenceId?: PresenceId;
    workloadMid?: WorkloadMid;
};

export type RunnerShutdownCause =
    | { kind: "signal"; signal: RunnerSignal }
    | { kind: "orphaned"; initialParentPid: number }
    | { kind: "stop" };

export type RunnerShutdownContext = RunnerPresenceLifecycleContext & {
    cause: RunnerShutdownCause;
};

export type RunnerPresenceLifecycleHook = (
    context: RunnerPresenceLifecycleContext,
) => void | Promise<void>;

export type RunnerShutdownHook = (
    context: RunnerShutdownContext,
) => void | Promise<void>;

export type RunnerSdk = {
    readonly workloads: RunnerWorkloads;
    readonly secrets: RunnerSecrets;
    readonly mounts: RunnerMounts;
    mount(mount: RunnerSdkMount): void;
    hijackConsoleLogging(): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
};
