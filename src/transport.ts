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

import type { HostedBind, HostedBindValue } from "./public-types.ts";

const FRAMED_H1_PATH = "/_capakit/framed";
const FRAMED_H1_CONTENT_TYPE = "application/x-capakit-body-frame-jsonl";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

type FrameHeaders = {
    pseudo: {
        method?: string;
        path?: string;
        status?: number;
        authority?: string;
        scheme?: string;
    };
    raw: Record<string, string[]>;
};

type BodyFrame =
    | { type: "start"; headers: FrameHeaders }
    | { type: "data"; chunk: string }
    | { type: "end"; trailers?: Record<string, string[]> | null; error?: WireError | null };

type WireError = {
    code?: string;
    message?: string;
    options?: {
        retryable?: boolean;
        details?: unknown;
        termination?: unknown;
    } | null;
};

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
): HttpServer {
    return createServer((request, response) => {
        void handleFramedHttpRequest(request, response, handler);
    });
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
        const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
        const url = new URL(request.url);
        const frames: BodyFrame[] = [
            {
                type: "start",
                headers: {
                    pseudo: {
                        method: request.method,
                        path: `${url.pathname}${url.search}`,
                        scheme: url.protocol.replace(":", "") || "http",
                        authority: url.host || "capakit.local",
                    },
                    raw: headersToRaw(request.headers),
                },
            },
        ];
        if (body && body.length > 0) {
            frames.push({ type: "data", chunk: body.toString("base64") });
        }
        frames.push({ type: "end", trailers: null, error: null });
        return responseFromFrames(await postBodyFrames(bind, frames, request.signal));
    };
}

export async function framesFromResponse(response: Response): Promise<BodyFrame[]> {
    const frames: BodyFrame[] = [
        {
            type: "start",
            headers: {
                pseudo: { status: response.status },
                raw: headersToRaw(response.headers),
            },
        },
    ];
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 0) {
        frames.push({ type: "data", chunk: body.toString("base64") });
    }
    frames.push({ type: "end", trailers: null, error: null });
    return frames;
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

async function handleFramedHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    handler: (request: Request) => Promise<Response>,
): Promise<void> {
    if (request.method !== "POST" || request.url !== FRAMED_H1_PATH) {
        response.writeHead(404);
        response.end();
        return;
    }
    try {
        const frames = decodeBodyFrames(await readIncomingBody(request));
        const start = frames.find((frame): frame is Extract<BodyFrame, { type: "start" }> => frame.type === "start");
        if (!start) {
            throw new Error("hosted framed request is missing start frame");
        }
        const end = frames.find((frame): frame is Extract<BodyFrame, { type: "end" }> => frame.type === "end");
        if (!end) {
            throw new Error("hosted framed request is missing end frame");
        }
        if (end?.error) {
            throw new Error(formatWireError(end.error));
        }
        const body = Buffer.concat(
            frames
                .filter((frame): frame is Extract<BodyFrame, { type: "data" }> => frame.type === "data")
                .map((frame) => Buffer.from(frame.chunk, "base64")),
        );
        const method = start.headers.pseudo.method ?? "GET";
        const path = start.headers.pseudo.path ?? "/";
        const appResponse = await handler(
            new Request(`http://capakit.local${path}`, {
                method,
                headers: rawToHeaders(start.headers.raw),
                body: method === "GET" || method === "HEAD" ? undefined : new Blob([Uint8Array.from(body)]),
            }),
        );
        response.writeHead(200, {
            "content-type": FRAMED_H1_CONTENT_TYPE,
        });
        response.end(encodeBodyFrames(await framesFromResponse(appResponse)));
    } catch (error) {
        response.writeHead(200, {
            "content-type": FRAMED_H1_CONTENT_TYPE,
        });
        response.end(encodeBodyFrames([
            {
                type: "end",
                trailers: null,
                error: {
                    code: "Internal",
                    message: error instanceof Error ? error.message : String(error),
                    options: { retryable: false },
                },
            },
        ]));
    }
}

async function postBodyFrames(
    bind: HostedBind,
    frames: BodyFrame[],
    signal: AbortSignal,
): Promise<BodyFrame[]> {
    const body = encodeBodyFrames(frames);
    return await new Promise<BodyFrame[]>((resolve, reject) => {
        const req = requestHttp(framedRequestOptions(bind, body.length), async (response) => {
            try {
                const status = response.statusCode ?? 0;
                if (status !== 200) {
                    response.destroy();
                    reject(new Error(`hosted framed request failed with status ${status || "unknown"}`));
                    return;
                }
                resolve(decodeBodyFrames(await readIncomingBody(response)));
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
        const abort = () => {
            req.destroy(new Error("hosted framed request aborted"));
        };
        if (signal.aborted) {
            abort();
            reject(new Error("hosted framed request aborted"));
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        req.on("error", (error) => reject(error));
        req.on("close", () => signal.removeEventListener("abort", abort));
        req.end(body);
    });
}

function responseFromFrames(frames: BodyFrame[]): Response {
    const start = frames.find((frame): frame is Extract<BodyFrame, { type: "start" }> => frame.type === "start");
    const end = frames.find((frame): frame is Extract<BodyFrame, { type: "end" }> => frame.type === "end");
    if (end?.error) {
        throw new Error(formatWireError(end.error));
    }
    if (!start) {
        throw new Error("hosted framed response is missing start frame");
    }
    if (!end) {
        throw new Error("hosted framed response is missing end frame");
    }
    const body = Buffer.concat(
        frames
            .filter((frame): frame is Extract<BodyFrame, { type: "data" }> => frame.type === "data")
            .map((frame) => Buffer.from(frame.chunk, "base64")),
    );
    return new Response(body, {
        status: start.headers.pseudo.status ?? 200,
        headers: responseHeadersToWeb(start.headers.raw),
    });
}

function encodeBodyFrames(frames: BodyFrame[]): Buffer {
    const lines = frames.map((frame) => {
        const encoded = Buffer.from(JSON.stringify(frame), "utf8");
        if (encoded.length > MAX_FRAME_BYTES) {
            throw new Error("hosted framed frame exceeds maximum size");
        }
        return encoded;
    });
    return Buffer.concat(lines.flatMap((line) => [line, Buffer.from("\n")]));
}

function decodeBodyFrames(body: Buffer): BodyFrame[] {
    if (body.length > MAX_BUFFER_BYTES) {
        throw new Error("hosted framed body exceeds maximum size");
    }
    return body
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => decodeBodyFrame(line, index));
}

function decodeBodyFrame(line: string, index: number): BodyFrame {
    const frame = JSON.parse(line) as { type?: string };
    const frameType = frame.type;
    switch (frameType) {
        case "start":
        case "data":
        case "end":
            return frame as BodyFrame;
        default: {
            throw new Error(`hosted framed frame ${index} has unsupported type \`${frameType ?? "unknown"}\``);
        }
    }
}

async function readIncomingBody(stream: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

function headersToRaw(headers: Headers): FrameHeaders["raw"] {
    const raw: FrameHeaders["raw"] = {};
    headers.forEach((value, key) => {
        raw[key] = [value];
    });
    return raw;
}

function rawToHeaders(raw: FrameHeaders["raw"]): Headers {
    const headers = new Headers();
    for (const [key, values] of Object.entries(raw)) {
        headers.set(key, values.join(", "));
    }
    return headers;
}

function responseHeadersToWeb(headers: FrameHeaders["raw"]): Headers {
    const web = new Headers();
    for (const [key, values] of Object.entries(headers)) {
        if (!key.startsWith(":")) {
            web.set(key, values.join(", "));
        }
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

function framedRequestOptions(bind: HostedBind, contentLength: number): RequestOptions {
    const base: RequestOptions = {
        method: "POST",
        path: FRAMED_H1_PATH,
        headers: {
            "content-type": FRAMED_H1_CONTENT_TYPE,
            "content-length": String(contentLength),
            "connection": "close",
        },
    };
    if (bind.kind === "unix") {
        return { ...base, socketPath: bind.path, host: "localhost" };
    }
    if (bind.kind === "pipe") {
        return { ...base, socketPath: bind.name, host: "localhost" };
    }
    return { ...base, host: bind.host, port: bind.port };
}

function formatWireError(error: WireError): string {
    return error.message ?? `hosted framed request failed: ${JSON.stringify(error)}`;
}
