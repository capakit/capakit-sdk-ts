import type {
    RunnerSecrets,
    SecretMid,
} from "./public-types.ts";
import type { RunnerEnv } from "./runner-env.ts";
import { requireRunnerBridgeBind } from "./runner-env.ts";
import { RunnerBridgeClient } from "./rpc.ts";

type ResolveSecretResult = {
    value: string;
};

export class RunnerSecretsImpl implements RunnerSecrets {
    private readonly rpc: RunnerBridgeClient;

    constructor(env: RunnerEnv) {
        this.rpc = new RunnerBridgeClient(requireRunnerBridgeBind(env));
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
