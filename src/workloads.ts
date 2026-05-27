import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { endpointPath } from "./public-types.ts";
import type {
    A2aClient,
    AnthropicClient,
    ClientOptions,
    EndpointPath,
    GoogleAiStudioClient,
    OaicClient,
    RunnerWorkloadConnection,
    RunnerWorkloads,
    WebSocketClient,
    WorkloadMid,
} from "./public-types.ts";
import type { HostedWorkloadConnectionConfig, RunnerEnv } from "./runner-env.ts";
import { parseBind } from "./transport.ts";
import { HostedMcpClientTransport } from "./mcp.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";

export class RunnerWorkloadsImpl implements RunnerWorkloads {
    readonly workloads: ReadonlyArray<RunnerWorkloadConnection>;

    private readonly connections: ReadonlyMap<string, HostedWorkloadConnectionConfig>;
    private readonly mcpClients = new Set<Client>();

    constructor(env: RunnerEnv) {
        this.connections = new Map(
            env.connectedWorkloads.map((config) => [
                connectionKey(config.workloadMid, config.endpoint),
                config,
            ]),
        );
        this.workloads = env.connectedWorkloads.map(({ bind: _bind, ...publicConfig }) => publicConfig);
    }

    async mcpClient(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<Client> {
        if (options.signal?.aborted) {
            throw new Error(`MCP client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const client = new Client({
            name: "@capakit/sdk",
            version: "0.0.0",
        });
        const transport = new HostedMcpClientTransport(
            parseBind(connection.bind),
            endpointPath(endpointPathValue),
        );
        await client.connect(transport, { timeout: options.timeoutMs });
        this.mcpClients.add(client);
        return client;
    }

    async oaicClient(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<OaicClient> {
        if (options.signal?.aborted) {
            throw new Error(`OAIC client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const endpoint = endpointPath(endpointPathValue);
        const { default: OpenAI } = await import("openai");
        return new OpenAI({
            apiKey: "capakit-local",
            baseURL: localEndpointBaseUrl(endpoint, "/v1"),
            fetch: createExternalLlmFetch(parseBind(connection.bind), endpoint),
        });
    }

    async anthropicClient(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<AnthropicClient> {
        if (options.signal?.aborted) {
            throw new Error(`Anthropic client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const endpoint = endpointPath(endpointPathValue);
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        return new Anthropic({
            apiKey: "capakit-local",
            baseURL: localEndpointBaseUrl(endpoint),
            fetch: createExternalLlmFetch(parseBind(connection.bind), endpoint),
        });
    }

    async googleAiStudioClient(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<GoogleAiStudioClient> {
        if (options.signal?.aborted) {
            throw new Error(`Google AI Studio client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const endpoint = endpointPath(endpointPathValue);
        const hostedFetch = createExternalLlmFetch(parseBind(connection.bind), endpoint);
        const defaultFetch = globalThis.fetch.bind(globalThis);
        const { GoogleGenAI } = await import("@google/genai");
        globalThis.fetch = (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.hostname === "capakit.local") {
                return hostedFetch(request);
            }
            return defaultFetch(request);
        };
        return new GoogleGenAI({
            apiKey: "capakit-local",
            httpOptions: {
                baseUrl: localEndpointBaseUrl(endpoint),
                apiVersion: "v1beta",
            },
        });
    }

    async a2aClient(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<A2aClient> {
        if (options.signal?.aborted) {
            throw new Error(`A2A client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const { createA2aClient } = await import("./a2a.ts");
        return await createA2aClient(
            parseBind(connection.bind),
            endpointPath(endpointPathValue),
        );
    }

    async webSocket(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<WebSocketClient> {
        if (options.signal?.aborted) {
            throw new Error(`WebSocket request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const { connectHostedWebSocket } = await import("./websocket.ts");
        return await connectHostedWebSocket(
            parseBind(connection.bind),
            endpointPath(endpointPathValue),
            options.signal,
        );
    }

    async close(): Promise<void> {
        const clients = Array.from(this.mcpClients);
        this.mcpClients.clear();
        await Promise.all(clients.map((client) => client.close()));
    }
}

function connectionKey(workloadMidValue: WorkloadMid, endpointPathValue: EndpointPath): string {
    return `${workloadMidValue}\u0000${endpointPath(endpointPathValue)}`;
}
