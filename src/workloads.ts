import { A2AClient } from "@a2a-js/sdk/client";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import OpenAI from "openai";

import { createA2aClient } from "./a2a.ts";
import { endpointPath } from "./public-types.ts";
import type {
    ClientOptions,
    EndpointPath,
    RunnerWorkloadConnection,
    RunnerWorkloads,
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
            name: "capakit-sdk",
            version: "0.0.0",
        });
        const transport = new HostedMcpClientTransport(
            parseBind(connection.bind),
            endpointPath(endpointPathValue),
        );
        await client.connect(transport);
        this.mcpClients.add(client);
        return client;
    }

    async oaicClient(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): Promise<OpenAI> {
        if (options.signal?.aborted) {
            throw new Error(`OAIC client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const endpoint = endpointPath(endpointPathValue);
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
    ): Promise<Anthropic> {
        if (options.signal?.aborted) {
            throw new Error(`Anthropic client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const endpoint = endpointPath(endpointPathValue);
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
    ): Promise<GoogleGenAI> {
        if (options.signal?.aborted) {
            throw new Error(`Google AI Studio client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        const endpoint = endpointPath(endpointPathValue);
        const hostedFetch = createExternalLlmFetch(parseBind(connection.bind), endpoint);
        const defaultFetch = globalThis.fetch.bind(globalThis);
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
    ): Promise<A2AClient> {
        if (options.signal?.aborted) {
            throw new Error(`A2A client request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        return await createA2aClient(
            parseBind(connection.bind),
            endpointPath(endpointPathValue),
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
