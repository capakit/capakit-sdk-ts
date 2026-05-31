import type { A2aClient, A2aMountOptions } from "@capakit/sdk/a2a";
import type { AnthropicClient } from "@capakit/sdk/anthropic";
import type { GoogleAiStudioClient } from "@capakit/sdk/google-ai-studio";
import type { McpClient, MountMcpOptions } from "@capakit/sdk/mcp";
import type { OaicClient, OaicMountOptions } from "@capakit/sdk/oaic";
import type { WebSocketClient } from "@capakit/sdk/websocket";

export type ProviderImports = [
    A2aClient,
    A2aMountOptions,
    AnthropicClient,
    GoogleAiStudioClient,
    McpClient,
    MountMcpOptions,
    OaicClient,
    OaicMountOptions,
    WebSocketClient,
];
