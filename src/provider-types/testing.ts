import type { EndpointPath, RunnerSdk } from "../public-types.ts";

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

export declare function mountTests(
    sdk: RunnerSdk,
    options: MountTestsOptions,
): void;
