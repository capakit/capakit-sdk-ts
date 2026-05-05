import type {
    HostedBind,
    EndpointPath,
} from "./public-types.ts";
import { createHostedFetch } from "./transport.ts";

const UPSTREAM_PATH_HEADER = "x-capakit-external-llm-upstream-path";

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
