import type { A2aProvider } from "@capakit/sdk/a2a";
import type { AnthropicProvider } from "@capakit/sdk/anthropic";
import type { GoogleAiStudioProvider } from "@capakit/sdk/google-ai-studio";
import type { McpProvider } from "@capakit/sdk/mcp";
import type { OaicProvider } from "@capakit/sdk/oaic";
import type { WebSocketProvider } from "@capakit/sdk/websocket";

export type ProviderImports = [
    A2aProvider,
    AnthropicProvider,
    GoogleAiStudioProvider,
    McpProvider,
    OaicProvider,
    WebSocketProvider,
];
