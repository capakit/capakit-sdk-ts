# @capakit/sdk

Official TypeScript SDK for Bun workloads running inside CapaKit.

Use it to expose workload endpoints, call connected workloads, and read runtime resources declared in `capability.yml`.

## Add To A Workload

```sh
bun add @capakit/sdk
```

Add provider packages only for the adapters your workload imports:

| Adapter                         | Package                     |
|---------------------------------|-----------------------------|
| `@capakit/sdk/mcp`              | `@modelcontextprotocol/sdk` |
| `@capakit/sdk/oaic`             | `openai`                    |
| `@capakit/sdk/a2a`              | `@a2a-js/sdk`               |
| `@capakit/sdk/anthropic`        | `@anthropic-ai/sdk`         |
| `@capakit/sdk/google-ai-studio` | `@google/genai`             |
| `@capakit/sdk/websocket`        | `ws`                        |

## Basic Workload

```ts
import {createWorkloadSdk, endpointPath} from "@capakit/sdk";

const sdk = createWorkloadSdk();
sdk.hijackConsoleLogging();

sdk.mount({
    protocol: "http",
    endpoint: endpointPath("/http"),
    handler: async () => Response.json({ok: true}),
});

await sdk.start();
```

## MCP Endpoint

```ts
import {createWorkloadSdk} from "@capakit/sdk";
import {mountMcp} from "@capakit/sdk/mcp";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";

const sdk = createWorkloadSdk();
sdk.hijackConsoleLogging();

const server = new McpServer({
    name: process.env.CAPAKIT_WORKLOAD_KEY ?? "hello",
    version: "0.1.0",
});

server.registerTool(
    "hello-world",
    {
        description: "Return a hello world response.",
        inputSchema: {},
    },
    async () => ({
        content: [{type: "text", text: "hello world"}],
        structuredContent: {text: "hello world"},
    }),
);

mountMcp(sdk, {
    endpoint: "/mcp",
    server,
});

await sdk.start();
```

## Runtime Resources

Workloads can use only the mounts and connections declared for them in `capability.yml`.

```ts
import {
    endpointPath,
    hostMountKey,
    workloadKey,
} from "@capakit/sdk";
import type {WorkloadSdk} from "@capakit/sdk";
import {createOaicClient} from "@capakit/sdk/oaic";

export async function createModelRuntime(sdk: WorkloadSdk) {
    const models = sdk.mounts.get(hostMountKey("models"));
    if (!models) {
        throw new Error("missing required host mount `models`");
    }

    const client = await createOaicClient(
        sdk,
        workloadKey("llama"),
        endpointPath("/oaic"),
    );

    return {
        modelsDir: models.path,
        client,
    };
}
```

## Development

```sh
npm run typecheck
npm test
npm run check
```
