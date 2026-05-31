import { endpointPath } from "./ids.ts";
import type { EndpointPath, RunnerSdk } from "./public-types.ts";

export type TestCaseResponseJson = unknown;

export type TestHttpContext = {
    request: Request;
    json: unknown;
};

export type TestHttpCaseHandler = (
    context: TestHttpContext,
) => TestCaseResponseJson | Promise<TestCaseResponseJson>;

export type TestHttpCase =
    | TestHttpCaseHandler
    | {
        description?: string;
        run: TestHttpCaseHandler;
    };

export type MountTestsOptions = {
    endpoint?: string | EndpointPath;
    tests: Record<string, TestHttpCase>;
};

export function mountTests(sdk: RunnerSdk, options: MountTestsOptions): void {
    const endpoint = normalizeEndpoint(options.endpoint ?? "/test");
    sdk.mount({
        protocol: "http",
        endpoint,
        handler: async (request) => {
            try {
                return await handleTestRequest(endpoint, options.tests, request);
            } catch (error) {
                return Response.json(
                    {
                        error: error instanceof Error ? error.message : String(error),
                    },
                    { status: 500 },
                );
            }
        },
    });
}

async function handleTestRequest(
    endpoint: EndpointPath,
    tests: Record<string, TestHttpCase>,
    request: Request,
): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === endpoint) {
        return Response.json({
            tests: Object.entries(tests).map(([id, definition]) => ({
                id,
                description:
                    typeof definition === "function"
                        ? undefined
                        : definition.description,
            })),
        });
    }
    if (request.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    const id = testIdFromPath(url.pathname, endpoint);
    const definition = id ? tests[id] : undefined;
    if (!id || !definition) {
        return Response.json({ error: "not found" }, { status: 404 });
    }

    const run = typeof definition === "function" ? definition : definition.run;
    const json = await requestJson(request);
    return Response.json(await run({ request, json }));
}

function normalizeEndpoint(value: string | EndpointPath): EndpointPath {
    return endpointPath(value.startsWith("/") ? value : `/${value}`);
}

function testIdFromPath(pathname: string, endpoint: EndpointPath): string | null {
    const prefix = `${endpoint}/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }
    const id = pathname.slice(prefix.length);
    return id && !id.includes("/") ? id : null;
}

async function requestJson(request: Request): Promise<unknown> {
    if (!request.body) {
        return {};
    }
    const text = await request.text();
    return text ? JSON.parse(text) : {};
}
