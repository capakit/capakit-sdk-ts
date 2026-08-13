import { endpointPath } from "./ids.ts";
import type {
    ClientOptions,
    EndpointPath,
    WorkloadConnection,
    WorkloadEndpoint,
    WorkloadConnections,
    WorkloadKey,
} from "./public-types.ts";
import type { HostedWorkloadConnectionConfig, WorkloadEnv } from "./workload-env.ts";
import { parseBind } from "./transport.ts";

export class WorkloadConnectionsImpl implements WorkloadConnections {
    readonly workloads: ReadonlyArray<WorkloadConnection>;

    private readonly connections: ReadonlyMap<string, HostedWorkloadConnectionConfig>;
    constructor(env: WorkloadEnv) {
        this.connections = new Map(
            env.connectedWorkloads.map((config) => [
                connectionKey(config.workloadKey, config.endpoint),
                config,
            ]),
        );
        this.workloads = env.connectedWorkloads.map(({ bind: _bind, ...publicConfig }) => publicConfig);
    }

    endpoint(
        workloadKeyValue: WorkloadKey,
        endpointPathValue: EndpointPath,
        options: ClientOptions = {},
    ): WorkloadEndpoint {
        if (options.signal?.aborted) {
            throw new Error(`workload endpoint request aborted for workload \`${workloadKeyValue}\``);
        }

        const connection = this.connections.get(connectionKey(workloadKeyValue, endpointPathValue));
        if (!connection) {
            throw new Error(
                `workload endpoint \`${workloadKeyValue}${endpointPath(endpointPathValue)}\` is not available`,
            );
        }
        return {
            workloadKey: connection.workloadKey,
            endpoint: endpointPath(connection.endpoint),
            protocol: connection.protocol,
            bind: parseBind(connection.bind),
        };
    }

    async close(): Promise<void> {
    }
}

function connectionKey(workloadKeyValue: WorkloadKey, endpointPathValue: EndpointPath): string {
    return `${workloadKeyValue}\u0000${endpointPath(endpointPathValue)}`;
}
