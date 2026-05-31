import type { EndpointPath, RunnerSdk } from "../public-types.ts";

/** JSON value returned by a mounted test case and validated by `capakit test`. */
export type TestJsonValue =
    | string
    | number
    | boolean
    | null
    | TestJsonValue[]
    | { [key: string]: TestJsonValue };

/**
 * Context passed to one mounted HTTP test case.
 *
 * `json` is the parsed request body sent by `capakit test` from
 * `capability-test.yml`'s `request.json` field, or `{}` when the request has
 * no body. Treat it as untrusted input and validate/narrow it in the test.
 */
export type TestHttpContext = {
    request: Request;
    json: unknown;
};

/** A single `/test/<id>` case. Return JSON for `capakit test` validations. */
export type TestHttpCaseHandler = (
    context: TestHttpContext,
) => TestJsonValue | Promise<TestJsonValue>;

/**
 * A mounted test case can be a handler directly or an object with a short
 * description for discovery via `GET /test`.
 */
export type TestHttpCase =
    | TestHttpCaseHandler
    | {
        description?: string;
        run: TestHttpCaseHandler;
    };

export type MountTestsOptions = {
    /** HTTP endpoint to mount. Defaults to `/test`. */
    endpoint?: string | EndpointPath;
    /** Map of URL-safe test ids to handlers, invoked as `POST <endpoint>/<id>`. */
    tests: Record<string, TestHttpCase>;
};

export declare function mountTests(
    sdk: RunnerSdk,
    options: MountTestsOptions,
): void;
