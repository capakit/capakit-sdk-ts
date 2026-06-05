import type {
    WorkloadSecrets,
    SecretMid,
} from "./public-types.ts";
import type { WorkloadEnv } from "./workload-env.ts";
import { requireWorkloadBridgeBind } from "./workload-env.ts";
import { WorkloadBridgeClient } from "./rpc.ts";

type ResolveSecretResult = {
    value: string;
};

export class WorkloadSecretsImpl implements WorkloadSecrets {
    private readonly rpc: WorkloadBridgeClient;

    constructor(env: WorkloadEnv) {
        this.rpc = new WorkloadBridgeClient(requireWorkloadBridgeBind(env));
    }

    async resolve(secretMid: SecretMid): Promise<string> {
        const result = await this.rpc.call<ResolveSecretResult>("resolve_secret", {
            secret_mid: secretMid,
        });
        return result.value;
    }

    async close(): Promise<void> {
        await this.rpc.close();
    }
}
