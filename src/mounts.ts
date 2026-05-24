import type {
    HostMount,
    HostMountAccess,
    HostMountMid,
    RunnerMounts,
} from "./public-types.ts";
import type { RunnerEnv } from "./runner-env.ts";

export class RunnerMountsImpl implements RunnerMounts {
    private readonly mountByMid: ReadonlyMap<HostMountMid, HostMount>;

    constructor(env: RunnerEnv) {
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
