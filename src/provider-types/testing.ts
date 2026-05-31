import type { EndpointPath, RunnerSdk } from "../public-types.ts";

export type TestHttpContext = {
    request: Request;
    json: unknown;
};

export type TestHttpHandler = (
    context: TestHttpContext,
) => unknown | Promise<unknown>;

export type TestHttpDefinition =
    | TestHttpHandler
    | {
        description?: string;
        run: TestHttpHandler;
    };

export type MountTestsOptions = {
    endpoint?: string | EndpointPath;
    tests: Record<string, TestHttpDefinition>;
};

export declare function mountTests(
    sdk: RunnerSdk,
    options: MountTestsOptions,
): void;
