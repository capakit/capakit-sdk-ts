import type {
    HostMount,
    HostMountAccess,
    HostMountKey,
    HostMounts,
} from "./public-types.ts";
import type { WorkloadEnv } from "./workload-env.ts";

export class HostMountsImpl implements HostMounts {
    private readonly mountByKey: ReadonlyMap<HostMountKey, HostMount>;

    constructor(env: WorkloadEnv) {
        this.mountByKey = new Map(env.mounts.map((mount) => [mount.key, mount]));
    }

    get(mountKey: HostMountKey): HostMount | undefined {
        return this.mountByKey.get(mountKey);
    }

    list(): readonly HostMount[] {
        return Array.from(this.mountByKey.values());
    }
}

export function normalizeMountAccess(value: unknown): HostMountAccess {
    switch (value) {
        case "read_only":
        case "read-write":
        case "read_write":
        case "read-only":
            return value.replace("-", "_") as HostMountAccess;
        default:
            throw new Error(`unsupported host mount access \`${String(value)}\``);
    }
}
