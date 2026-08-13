import type {
    ClientOptions,
    EndpointPath,
    WorkloadSdk,
    WorkloadKey,
} from "./public-types.ts";
import { registerSdkClientCleanup } from "./client-lifecycle.ts";
import { createExternalLlmFetch, localEndpointBaseUrl } from "./oaic.ts";
import { GoogleGenAI } from "@google/genai";

export type GoogleAiStudioClient = GoogleGenAI;

type FetchRoute = {
    endpoint: EndpointPath;
    fetch: typeof fetch;
};

type GoogleAiStudioFetchPatch = {
    originalFetch: typeof fetch;
    patchedFetch: typeof fetch;
    routes: Map<symbol, FetchRoute>;
};

let fetchPatch: GoogleAiStudioFetchPatch | undefined;

export async function createGoogleAiStudioClient(
    sdk: WorkloadSdk,
    workloadKey: WorkloadKey,
    endpointPath: EndpointPath,
    options: ClientOptions = {},
): Promise<GoogleAiStudioClient> {
    const endpoint = sdk.workloads.endpoint(workloadKey, endpointPath, options);
    const hostedFetch = createExternalLlmFetch(endpoint.bind, endpoint.endpoint);
    const cleanupFetchRoute = installGoogleAiStudioFetchRoute(
        endpoint.endpoint,
        hostedFetch,
    );
    try {
        const client = new GoogleGenAI({
            apiKey: "capakit-local",
            httpOptions: {
                baseUrl: localEndpointBaseUrl(endpoint.endpoint),
                apiVersion: "v1beta",
            },
        });
        registerSdkClientCleanup(sdk, cleanupFetchRoute);
        return client;
    } catch (error) {
        cleanupFetchRoute();
        throw error;
    }
}

function installGoogleAiStudioFetchRoute(
    endpoint: EndpointPath,
    routeFetch: typeof fetch,
): () => void {
    const patch = fetchPatch ?? installGoogleAiStudioFetchPatch();
    const routeId = Symbol("google-ai-studio-fetch-route");
    patch.routes.set(routeId, { endpoint, fetch: routeFetch });
    return () => {
        patch.routes.delete(routeId);
        if (patch.routes.size === 0 && fetchPatch === patch) {
            fetchPatch = undefined;
            if (globalThis.fetch === patch.patchedFetch) {
                globalThis.fetch = patch.originalFetch;
            }
        }
    };
}

function installGoogleAiStudioFetchPatch(): GoogleAiStudioFetchPatch {
    const originalFetch = globalThis.fetch;
    const routes = new Map<symbol, FetchRoute>();
    const patch: GoogleAiStudioFetchPatch = {
        originalFetch,
        patchedFetch: (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.hostname === "capakit.local") {
                const route = routeForPath(routes, url.pathname);
                if (route) {
                    return route.fetch(request);
                }
            }
            return originalFetch.call(globalThis, request);
        },
        routes,
    };
    fetchPatch = patch;
    globalThis.fetch = patch.patchedFetch;
    return patch;
}

function routeForPath(
    routes: Map<symbol, FetchRoute>,
    pathname: string,
): FetchRoute | undefined {
    let matched: FetchRoute | undefined;
    for (const route of routes.values()) {
        if (pathMatchesEndpoint(pathname, route.endpoint)) {
            if (!matched || route.endpoint.length > matched.endpoint.length) {
                matched = route;
            }
        }
    }
    return matched;
}

function pathMatchesEndpoint(pathname: string, endpoint: EndpointPath): boolean {
    return pathname === endpoint || pathname.startsWith(`${endpoint}/`);
}
