import type {
    HostMount,
    HostMountAccess,
    HostMountMid,
    HostMounts,
} from "./public-types.ts";
import type { WorkloadEnv } from "./workload-env.ts";

export class HostMountsImpl implements HostMounts {
    private readonly mountByMid: ReadonlyMap<HostMountMid, HostMount>;

    constructor(env: WorkloadEnv) {
        this.mountByMid = new Map(env.mounts.map((mount) => [mount.mid, mount]));
    }

    get(mountMid: HostMountMid): HostMount | undefined {
        return this.mountByMid.get(mountMid);
    }

    list(): readonly HostMount[] {
        return Array.from(this.mountByMid.values());
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
