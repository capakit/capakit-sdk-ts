import { format } from "node:util";

type WireLogLevel = "Debug" | "Info" | "Warn" | "Error";
type ConsoleMethod = "debug" | "info" | "log" | "warn" | "error";

type WireLogRecord = {
    v: 1;
    ev: {
        level: WireLogLevel;
        msg: string;
        time: number;
        component: null;
        fields: null;
        err: null;
        category: "user";
        origin: {
            stream: "structured";
        };
    };
    ctx: {
        app_name: null;
        server_id: null;
        pid: number;
        start_time: null;
        meta: null;
    };
};

const LEVEL_BY_METHOD: Record<ConsoleMethod, WireLogLevel> = {
    debug: "Debug",
    info: "Info",
    log: "Info",
    warn: "Warn",
    error: "Error",
};

const originals = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error,
};

export function installHostConsoleLogging(): () => void {
    for (const method of Object.keys(LEVEL_BY_METHOD) as ConsoleMethod[]) {
        console[method] = (...args: unknown[]) => {
            writeWireHostLog(method, args);
        };
    }

    return () => {
        for (const method of Object.keys(LEVEL_BY_METHOD) as ConsoleMethod[]) {
            console[method] = originals[method];
        }
    };
}

function writeWireHostLog(method: ConsoleMethod, args: readonly unknown[]): void {
    const level = LEVEL_BY_METHOD[method];
    const text = format(...args);
    const line = JSON.stringify(buildWireLogRecord(level, text));
    const write = method === "warn" || method === "error"
        ? process.stderr.write.bind(process.stderr)
        : process.stdout.write.bind(process.stdout);

    try {
        write(`${line}\n`);
    } catch (error) {
        originals.error("[capakit-sdk] failed to write host log", error);
    }
}

function buildWireLogRecord(
    level: WireLogLevel,
    text: string,
): WireLogRecord {
    return {
        v: 1,
        ev: {
            level,
            msg: `[host-log][${level.toLowerCase()}] ${text}`,
            time: Date.now(),
            component: null,
            fields: null,
            err: null,
            category: "user",
            origin: {
                stream: "structured",
            },
        },
        ctx: {
            app_name: null,
            server_id: null,
            pid: process.pid,
            start_time: null,
            meta: null,
        },
    };
}
