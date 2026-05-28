import type { RunnerSdk, RunnerSdkMount, ClientOptions, EndpointPath, WorkloadMid } from "../public-types.ts";

export type McpClient = import("@modelcontextprotocol/sdk/client/index.js").Client;
export type McpServer = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
export type McpSessionId = string;
export type McpMountOptions = { endpoint: EndpointPath; server: McpServer };
export type McpProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<McpClient>;
    mount(options: McpMountOptions): RunnerSdkMount;
    close(): Promise<void>;
};
export declare function mcpProvider(sdk: RunnerSdk): McpProvider;
