import type {
    ClientOptions,
    HostedBind,
    EndpointPath,
    RunnerHttpHandler,
    RunnerSdk,
    RunnerSdkMount,
    WorkloadMid,
} from "./public-types.ts";
import { endpointPath as normalizeEndpointPath } from "./ids.ts";
import { createHostedFetch } from "./transport.ts";
import OpenAI from "openai";

const UPSTREAM_PATH_HEADER = "x-capakit-external-llm-upstream-path";

export type OaicClient = OpenAI;

export type OaicMountOptions = {
    endpoint: string | EndpointPath;
    handler: RunnerHttpHandler;
};

export async function createOaicClient(
    sdk: RunnerSdk,
    workloadMid: WorkloadMid,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<OaicClient> {
    const endpoint = sdk.workloads.endpoint(workloadMid, endpointPath, options);
    return new OpenAI({
        apiKey: "capakit-local",
        baseURL: localEndpointBaseUrl(endpoint.endpoint, "/v1"),
        fetch: createExternalLlmFetch(endpoint.bind, endpoint.endpoint),
    });
}

export function mountOaic(sdk: RunnerSdk, options: OaicMountOptions): void {
    sdk.mount(createOaicMount(options));
}

function createOaicMount(options: OaicMountOptions): RunnerSdkMount {
    return {
        protocol: "oaic",
        endpoint: normalizeEndpoint(options.endpoint),
        handler: options.handler,
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

function normalizeEndpoint(value: string | EndpointPath): EndpointPath {
    return typeof value === "string" ? normalizeEndpointPath(value) : value;
}
