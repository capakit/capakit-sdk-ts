import { connect as connectHttp2 } from "node:http2";
import type {
    ClientHttp2Stream,
    ClientSessionOptions,
    Http2Server,
    IncomingHttpHeaders,
    OutgoingHttpHeaders,
    ServerHttp2Stream,
} from "node:http2";
import { unlink } from "node:fs/promises";
import { connect as connectNet } from "node:net";

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

export async function listen(server: Http2Server, bind: HostedBind): Promise<void> {
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

export async function closeServer(server: Http2Server): Promise<void> {
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
        const session = connectHttp2(
            clientAuthority(bind),
            clientConnectOptions(bind),
        );
        let stream: ClientHttp2Stream | undefined;

        const abort = () => {
            stream?.close();
            session.destroy();
        };
        request.signal.addEventListener("abort", abort, { once: true });

        try {
            const url = new URL(request.url);
            stream = session.request({
                ":method": request.method,
                ":path": `${url.pathname}${url.search}`,
                ...requestHeaders(request.headers),
            });

            const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
            if (body && body.length > 0) {
                stream.end(body);
            } else {
                stream.end();
            }

            const responseHeaders = await waitForResponse(stream, session);
            const responseBody = await readClientResponseBody(stream);

            const status = Number(responseHeaders[":status"] ?? 200);
            return new Response(responseBody, {
                status,
                headers: responseHeadersToWeb(responseHeaders),
            });
        } finally {
            request.signal.removeEventListener("abort", abort);
            stream?.close();
            session.close();
            session.destroy();
        }
    };
}

function waitForResponse(
    stream: ClientHttp2Stream,
    session: ReturnType<typeof connectHttp2>,
): Promise<IncomingHttpHeaders> {
    return new Promise<IncomingHttpHeaders>((resolve, reject) => {
        const cleanup = () => {
            stream.off("response", onResponse);
            stream.off("error", onError);
            session.off("error", onError);
            session.off("close", onClose);
        };
        const onResponse = (headers: IncomingHttpHeaders) => {
            cleanup();
            resolve(headers);
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(new Error("hosted fetch session closed before response"));
        };

        stream.once("response", onResponse);
        stream.once("error", onError);
        session.once("error", onError);
        session.once("close", onClose);
    });
}

async function readClientResponseBody(stream: ClientHttp2Stream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

export async function readRequestBody(
    stream: ServerHttp2Stream,
): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) {
        return null;
    }
    return Buffer.concat(chunks);
}

export async function writeFetchResponse(
    stream: ServerHttp2Stream,
    response: Response,
    extraHeaders: IncomingHttpHeaders = {},
): Promise<void> {
    if (stream.destroyed || stream.closed) {
        return;
    }

    stream.respond({
        ":status": response.status,
        ...extraHeaders,
        ...webHeadersToNode(response.headers),
    });

    if (!response.body) {
        stream.end();
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
                stream.write(Buffer.from(value));
            }
        }
        stream.end();
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

function requestHeaders(headers: Headers): OutgoingHttpHeaders {
    const raw: OutgoingHttpHeaders = {};
    headers.forEach((value, key) => {
        raw[key] = value;
    });
    return raw;
}

function responseHeadersToWeb(headers: IncomingHttpHeaders): Headers {
    const web = new Headers();
    for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith(":") || value === undefined) {
            continue;
        }
        web.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return web;
}

function webHeadersToNode(headers: Headers): OutgoingHttpHeaders {
    const raw: OutgoingHttpHeaders = {};
    headers.forEach((value, key) => {
        raw[key] = value;
    });
    return raw;
}

export function clientConnectOptions(bind: HostedBind): ClientSessionOptions | undefined {
    if (bind.kind === "unix") {
        return {
            createConnection: () => connectNet(bind.path),
        };
    }
    if (bind.kind === "pipe") {
        return {
            createConnection: () => connectNet(bind.name),
        };
    }
    return undefined;
}
