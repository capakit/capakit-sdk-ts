import type {
    ClientOptions,
    HostedBind,
    EndpointPath,
    RunnerHttpHandler,
    RunnerSdk,
    RunnerSdkMount,
    WorkloadMid,
} from "./public-types.ts";
import { createHostedFetch } from "./transport.ts";
import { optionalModule } from "./optional-imports.ts";

const UPSTREAM_PATH_HEADER = "x-capakit-external-llm-upstream-path";

export type OaicClient = import("openai").default;

export type OaicProvider = {
    createClient(
        workloadMid: WorkloadMid,
        endpointPath: EndpointPath,
        options?: ClientOptions,
    ): Promise<OaicClient>;
    mount(options: OaicMountOptions): RunnerSdkMount;
};

export type OaicMountOptions = {
    endpoint: EndpointPath;
    handler: RunnerHttpHandler;
};

export function oaicProvider(sdk: RunnerSdk): OaicProvider {
    return {
        async createClient(workloadMid, endpointPath, options = {}) {
            const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
            const { default: OpenAI } = await import(optionalModule("openai"));
            return new OpenAI({
                apiKey: "capakit-local",
                baseURL: localEndpointBaseUrl(endpoint.endpoint, "/v1"),
                fetch: createExternalLlmFetch(endpoint.bind, endpoint.endpoint),
            });
        },
        mount(options) {
            return {
                protocol: "oaic",
                endpoint: options.endpoint,
                handler: options.handler,
            };
        },
    };
}

export function localEndpointBaseUrl(
    endpoint: EndpointPath,
    upstreamBasePath = "",
): string {
    return `http://capakit.local${endpoint}${upstreamBasePath}`;
}

export function createExternalLlmFetch(
    bind: HostedBind,
    endpoint: EndpointPath,
): typeof fetch {
    const hostedFetch = createHostedFetch(bind);
    return (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set(UPSTREAM_PATH_HEADER, upstreamPathFromLocalUrl(request.url, endpoint));
        return hostedFetch(new Request(request, { headers }));
    };
}

function upstreamPathFromLocalUrl(requestUrl: string, endpoint: EndpointPath): string {
    const url = new URL(requestUrl);
    const path = `${url.pathname}${url.search}`;
    if (url.pathname === endpoint) {
        return url.search ? `/${url.search}` : "/";
    }
    if (url.pathname.startsWith(`${endpoint}/`)) {
        return `${url.pathname.slice(endpoint.length)}${url.search}`;
    }
    return path;
}
