import type { RunnerSdk, RunnerSdkMount, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type McpClient = import("@modelcontextprotocol/sdk/client/index.js").Client;
export type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
export type McpSessionId = string;
export type MountMcpOptions = { endpoint: string | EndpointPath; server: McpServer };
export declare function createMcpClient(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options?: ClientOptions,
): Promise<McpClient>;
export declare function mountMcp(sdk: RunnerSdk, options: MountMcpOptions): void;
export declare function createMcpMount(options: MountMcpOptions): RunnerSdkMount;
