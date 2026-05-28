import type {
    EndpointPath,
    HostMountMid,
    SecretMid,
    WorkloadMid,
} from "./public-types.ts";

export function endpointPath(value: string): EndpointPath {
    if (value.length === 0) {
        throw new Error("endpoint path must not be empty");
    }
    return (value.startsWith("/") ? value : `/${value}`) as EndpointPath;
}

export function workloadMid(value: string): WorkloadMid {
    return value as WorkloadMid;
}

export function secretMid(value: string): SecretMid {
    return value as SecretMid;
}

export function hostMountMid(value: string): HostMountMid {
    return value as HostMountMid;
}
