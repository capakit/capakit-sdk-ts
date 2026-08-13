import type {
    WorkloadSecrets,
    SecretKey,
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

    async resolve(secretKey: SecretKey): Promise<string> {
        const result = await this.rpc.call<ResolveSecretResult>("resolve_secret", {
            secret_key: secretKey,
        });
        return result.value;
    }

    async close(): Promise<void> {
        await this.rpc.close();
    }
}
