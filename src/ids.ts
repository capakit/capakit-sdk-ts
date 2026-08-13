import type {
    EndpointPath,
    HostMountKey,
    SecretKey,
    WorkloadKey,
} from "./public-types.ts";

export function endpointPath(value: string): EndpointPath {
    if (value.length === 0) {
        throw new Error("endpoint path must not be empty");
    }
    return (value.startsWith("/") ? value : `/${value}`) as EndpointPath;
}

export function workloadKey(value: string): WorkloadKey {
    return manifestKey(value, "workload") as WorkloadKey;
}

export function secretKey(value: string): SecretKey {
    return manifestKey(value, "secret") as SecretKey;
}

export function hostMountKey(value: string): HostMountKey {
    return manifestKey(value, "host mount") as HostMountKey;
}

function manifestKey(value: string, kind: string): string {
    if (!/^[a-z](?:[a-z0-9_-]*[a-z0-9])?$/.test(value)) {
        throw new Error(
            `${kind} key must start with a lowercase ASCII letter, end with a lowercase ASCII letter or digit, and contain only lowercase ASCII letters, digits, \`_\`, or \`-\``,
        );
    }
    return value;
}
