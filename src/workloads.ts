import { endpointPath } from "./ids.ts";
import type {
    ClientOptions,
    EndpointPath,
    RunnerWorkloadConnection,
    RunnerWorkloadEndpoint,
    RunnerWorkloads,
    WorkloadMid,
} from "./public-types.ts";
import type { HostedWorkloadConnectionConfig, RunnerEnv } from "./runner-env.ts";
import { parseBind } from "./transport.ts";

export class RunnerWorkloadsImpl implements RunnerWorkloads {
    readonly workloads: ReadonlyArray<RunnerWorkloadConnection>;

    private readonly connections: ReadonlyMap<string, HostedWorkloadConnectionConfig>;
    constructor(env: RunnerEnv) {
        this.connections = new Map(
            env.connectedWorkloads.map((config) => [
                connectionKey(config.workloadMid, config.endpoint),
                config,
            ]),
        );
        this.workloads = env.connectedWorkloads.map(({ bind: _bind, ...publicConfig }) => publicConfig);
    }

    endpoint(
        workloadMidValue: WorkloadMid,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): RunnerWorkloadEndpoint {
        if (options.signal?.aborted) {
            throw new Error(`workload endpoint request aborted for workload \`${workloadMidValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadMidValue, endpointPathValue))!;
        return {
            workloadMid: connection.workloadMid,
            endpoint: endpointPath(connection.endpoint),
            protocol: connection.protocol,
            bind: parseBind(connection.bind),
        };
    }

    async close(): Promise<void> {
    }
}

function connectionKey(workloadMidValue: WorkloadMid, endpointPathValue: EndpointPath): string {
    return `${workloadMidValue}\u0000${endpointPath(endpointPathValue)}`;
}
