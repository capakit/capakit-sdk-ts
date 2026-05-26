import { createServer, request as requestHttp } from "node:http";
import type {
    IncomingHttpHeaders,
    IncomingMessage,
    OutgoingHttpHeaders,
    RequestOptions,
    Server as HttpServer,
    ServerResponse,
} from "node:http";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";

import type { HostedBind, HostedBindValue } from "./public-types.ts";

export function parseBind(value: HostedBindValue): HostedBind {
    if (value.startsWith("unix:")) {
        return { kind: "unix", path: value.slice("unix:".length) };
    }
    if (value.startsWith("tcp:")) {
        const rest = value.slice("tcp:".length);
        const lastColon = rest.lastIndexOf(":");
        if (lastColon <= 0) {
            throw new Error(`invalid tcp bind: ${value}`);
        }
        const host = rest.slice(0, lastColon);
        const port = Number(rest.slice(lastColon + 1));
        if (!Number.isInteger(port) || port <= 0) {
            throw new Error(`invalid tcp port in bind: ${value}`);
        }
        return { kind: "tcp", host, port };
    }
    if (value.startsWith("pipe:")) {
        const name = value.slice("pipe:".length);
        if (name.length === 0) {
            throw new Error(`invalid pipe bind: ${value}`);
        }
        return { kind: "pipe", name };
    }
    throw new Error(`unsupported runner bind: ${value}`);
}

export function createHostedServer(
    handler: (request: Request) => Promise<Response>,
    upgradeHandler?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
): HttpServer {
    const server = createServer((request, response) => {
        void handleRawHttpRequest(request, response, handler);
    });
    server.on("upgrade", (request, socket, head) => {
        if (!upgradeHandler) {
            socket.destroy();
            return;
        }
        upgradeHandler(request, socket, head);
    });
    return server;
}

export async function listen(server: HttpServer, bind: HostedBind): Promise<void> {
    if (bind.kind === "unix") {
        await removeSocket(bind.path);
    }
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        if (bind.kind === "unix") {
            server.listen(bind.path, () => resolve());
            return;
        }
        if (bind.kind === "pipe") {
            server.listen(bind.name, () => resolve());
            return;
        }
        server.listen(bind.port, bind.host, () => resolve());
    });
}

export async function closeServer(server: HttpServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function removeSocket(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

export function createHostedFetch(bind: HostedBind): typeof fetch {
    return async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body;
        const body = hasBody ? Buffer.from(await request.arrayBuffer()) : null;
        return await sendRawHttpRequest(bind, request, url, body);
    };
}

export async function writeFetchResponse(
    responseStream: ServerResponse,
    response: Response,
    extraHeaders: IncomingHttpHeaders = {},
): Promise<void> {
    if (responseStream.destroyed || responseStream.closed) {
        return;
    }
    responseStream.writeHead(response.status, {
        ...extraHeaders,
        ...webHeadersToNode(response.headers),
    });

    if (!response.body) {
        responseStream.end();
        return;
    }

    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value) {
                responseStream.write(Buffer.from(value));
            }
        }
        responseStream.end();
    } finally {
        reader.releaseLock();
    }
}

export function clientAuthority(bind: HostedBind): string {
    if (bind.kind === "unix" || bind.kind === "pipe") {
        return "http://localhost";
    }
    return `http://${bind.host}:${bind.port}`;
}

async function handleRawHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    handler: (request: Request) => Promise<Response>,
): Promise<void> {
    try {
        const method = request.method ?? "GET";
        const body = method === "GET" || method === "HEAD"
            ? undefined
            : new Blob([Uint8Array.from(await readIncomingBody(request))]);
        const appResponse = await handler(
            new Request(`http://capakit.local${request.url ?? "/"}`, {
                method,
                headers: nodeHeadersToWeb(request.headers),
                body,
            }),
        );
        await writeFetchResponse(response, appResponse);
    } catch (error) {
        if (!response.headersSent) {
            response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        response.end(error instanceof Error ? error.message : String(error));
    }
}

async function sendRawHttpRequest(
    bind: HostedBind,
    request: Request,
    url: URL,
    body: Buffer | null,
): Promise<Response> {
    return await new Promise<Response>((resolve, reject) => {
        let settled = false;
        const req = requestHttp(rawRequestOptions(bind, request, url, body?.length ?? 0), (response) => {
            settled = true;
            resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
                status: response.statusCode ?? 200,
                headers: nodeHeadersToWeb(response.headers),
            }));
        });
        const abort = () => {
            if (!settled) {
                settled = true;
                reject(new Error("hosted request aborted"));
            }
            req.destroy(new Error("hosted request aborted"));
        };
        if (request.signal.aborted) {
            abort();
            return;
        }
        request.signal.addEventListener("abort", abort, { once: true });
        req.on("error", (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        req.on("close", () => request.signal.removeEventListener("abort", abort));
        req.end(body ?? undefined);
    });
}

async function readIncomingBody(stream: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

function webHeadersToNode(headers: Headers): OutgoingHttpHeaders {
    const raw: OutgoingHttpHeaders = {};
    headers.forEach((value, key) => {
        raw[key] = value;
    });
    return raw;
}

function nodeHeadersToWeb(headers: IncomingHttpHeaders): Headers {
    const web = new Headers();
    for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
            web.set(key, value.join(", "));
        } else if (value !== undefined) {
            web.set(key, value);
        }
    }
    return web;
}

function rawRequestOptions(
    bind: HostedBind,
    request: Request,
    url: URL,
    contentLength: number,
): RequestOptions {
    const headers = webHeadersToNode(request.headers);
    if (contentLength > 0 && headers["content-length"] === undefined) {
        headers["content-length"] = String(contentLength);
    }
    const base: RequestOptions = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
    };
    if (bind.kind === "unix") {
        return { ...base, socketPath: bind.path, host: url.hostname || "localhost" };
    }
    if (bind.kind === "pipe") {
        return { ...base, socketPath: bind.name, host: url.hostname || "localhost" };
    }
    return { ...base, host: bind.host, port: bind.port };
}
