import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { AgentCard } from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";
import {
    DefaultRequestHandler,
    InMemoryTaskStore,
    JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import type {
    AgentExecutor,
    TaskStore,
} from "@a2a-js/sdk/server";

import type {
    EndpointPath,
    HostedBind,
    RunnerHttpHandler,
} from "./public-types.ts";
import { createHostedFetch } from "./transport.ts";

const AGENT_CARD_SUFFIX = `/${AGENT_CARD_PATH}`;

export function createA2aHandler(options: {
    agentCard: AgentCard;
    executor: AgentExecutor;
    taskStore?: TaskStore;
}): RunnerHttpHandler {
    const requestHandler = new DefaultRequestHandler(
        options.agentCard,
        options.taskStore ?? new InMemoryTaskStore(),
        options.executor,
    );
    const jsonRpc = new JsonRpcTransportHandler(requestHandler);

    return async (request) => {
        if (
            request.method === "GET" &&
            new URL(request.url).pathname.endsWith(AGENT_CARD_SUFFIX)
        ) {
            return jsonResponse(await requestHandler.getAgentCard());
        }

        if (request.method !== "POST") {
            return jsonResponse({ error: "not found" }, 404);
        }

        let payload: unknown;
        try {
            payload = await request.json();
        } catch {
            return jsonResponse(jsonRpcParseError(), 400);
        }

        const result = await jsonRpc.handle(payload);
        if (isAsyncIterable(result)) {
            return jsonLinesResponse(result);
        }
        return jsonResponse(result);
    };
}

export async function createA2aClient(
    bind: HostedBind,
    endpoint: EndpointPath,
): Promise<A2AClient> {
    return await A2AClient.fromCardUrl(
        `http://capakit.local${endpoint}${AGENT_CARD_SUFFIX}`,
        {
            fetchImpl: createHostedFetch(bind),
        },
    );
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
    });
}

function jsonLinesResponse(src: AsyncIterable<unknown>): Response {
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for await (const item of src) {
                        controller.enqueue(
                            encoder.encode(`${JSON.stringify(item)}\n`),
                        );
                    }
                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            },
        }),
        {
            status: 200,
            headers: {
                "content-type": "application/jsonl; charset=utf-8",
            },
        },
    );
}

function jsonRpcParseError() {
    return {
        jsonrpc: "2.0" as const,
        id: null,
        error: {
            code: -32700,
            message: "Parse error",
        },
    };
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        Symbol.asyncIterator in value
    );
}
