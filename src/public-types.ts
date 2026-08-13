declare const CAPAKIT_BRAND: unique symbol;

type Brand<T, Name extends string> = T & {
    readonly [CAPAKIT_BRAND]: Name;
};

export type HostedBindValue = string;
export type PresenceId = string;
export type EndpointPath = Brand<string, "EndpointPath">;
export type WorkloadKey = Brand<string, "WorkloadKey">;
export type SecretKey = Brand<string, "SecretKey">;
export type HostMountKey = Brand<string, "HostMountKey">;
export type EndpointProtocol = "http" | "mcp" | "oaic" | "a2a";
export type HostMountAccess = "read_only" | "read_write";

export type HostedBind =
    | { kind: "unix"; path: string }
    | { kind: "tcp"; host: string; port: number }
    | { kind: "pipe"; name: string };

export declare function endpointPath(value: string): EndpointPath;
export declare function workloadKey(value: string): WorkloadKey;
export declare function secretKey(value: string): SecretKey;
export declare function hostMountKey(value: string): HostMountKey;

export type ClientOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

export type WorkloadConnection = {
    workloadKey: WorkloadKey;
    endpoint: EndpointPath;
    protocol: EndpointProtocol;
};

export type WorkloadEndpoint = WorkloadConnection & {
    bind: HostedBind;
};

export type WorkloadConnections = {
    readonly workloads: ReadonlyArray<WorkloadConnection>;
    endpoint(
        workloadKey: WorkloadKey,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): WorkloadEndpoint;
    close(): Promise<void>;
};

export type WorkloadSecrets = {
    resolve(secretKey: SecretKey): Promise<string>;
    close(): Promise<void>;
};

export type HostMount = {
    key: HostMountKey;
    path: string;
    access: HostMountAccess;
};

export type HostMounts = {
    get(mountKey: HostMountKey): HostMount | undefined;
    list(): readonly HostMount[];
};

export type WorkloadSdkOptions = {
    bind?: HostedBindValue;
    onPresenceStart?: WorkloadPresenceLifecycleHook;
    onShutdown?: WorkloadShutdownHook;
};

export type WorkloadHttpHandlerContext = WorkloadPresenceLifecycleContext & {
    protocol: EndpointProtocol;
    endpoint: EndpointPath;
};

export type WorkloadHttpHandler = (
    request: Request,
    context: WorkloadHttpHandlerContext,
) => Response | Promise<Response>;

export type WorkloadHttpMount = {
    protocol: "http";
    endpoint: EndpointPath;
    handler: WorkloadHttpHandler;
};

export type WorkloadSdkMount = {
    protocol: EndpointProtocol;
    endpoint: EndpointPath;
    handler: WorkloadHttpHandler;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
};

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export type WorkloadPresenceLifecycleContext = {
    presenceId?: PresenceId;
    workloadKey?: WorkloadKey;
};

export type WorkloadShutdownCause =
    | { kind: "signal"; signal: ShutdownSignal }
    | { kind: "orphaned"; initialParentPid: number }
    | { kind: "stop" };

export type WorkloadShutdownContext = WorkloadPresenceLifecycleContext & {
    cause: WorkloadShutdownCause;
};

export type WorkloadPresenceLifecycleHook = (
    context: WorkloadPresenceLifecycleContext,
) => void | Promise<void>;

export type WorkloadShutdownHook = (
    context: WorkloadShutdownContext,
) => void | Promise<void>;

export type WorkloadSdk = {
    readonly workloads: WorkloadConnections;
    readonly secrets: WorkloadSecrets;
    readonly mounts: HostMounts;
    mount(mount: WorkloadSdkMount): void;
    hijackConsoleLogging(): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
};
