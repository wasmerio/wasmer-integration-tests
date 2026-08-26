// The one place the engine's surface is enumerated. Adding a state axis is
// one schema block, one lowering function and one line here - invariant I8.
// Loaded dynamically so `ass list`/`try`/`run` never pay for the
// simulator's client dependency tree.

import type { ResourceAdapter } from "../adapter";
import type { ResourceKind } from "../model";

export async function builtinAdapters(): Promise<
  Map<ResourceKind, ResourceAdapter>
> {
  const [
    identity,
    apps,
    subresources,
    requests,
    workloads,
    logs,
    usage,
    billing,
  ] = await Promise.all([
    import("../adapters/identity"),
    import("../adapters/apps"),
    import("../adapters/subresources"),
    import("../adapters/requests"),
    import("../adapters/workloads"),
    import("../adapters/logs"),
    import("../adapters/usage"),
    import("../adapters/billing"),
  ]);
  const all: ResourceAdapter[] = [
    identity.userAdapter as ResourceAdapter,
    identity.namespaceAdapter as ResourceAdapter,
    apps.appAdapter as ResourceAdapter,
    apps.appVersionAdapter as ResourceAdapter,
    subresources.domainAdapter as ResourceAdapter,
    subresources.volumeAdapter as ResourceAdapter,
    subresources.databaseAdapter as ResourceAdapter,
    subresources.cronjobAdapter as ResourceAdapter,
    billing.planVersionAdapter as ResourceAdapter,
    billing.subscriptionAdapter as ResourceAdapter,
    billing.invoiceAdapter as ResourceAdapter,
    requests.requestDayAdapter as ResourceAdapter,
    requests.requestBucketAdapter as ResourceAdapter,
    requests.literalRequestAdapter as ResourceAdapter,
    workloads.workloadDayAdapter as ResourceAdapter,
    workloads.workloadBucketAdapter as ResourceAdapter,
    logs.logLineAdapter as ResourceAdapter,
    usage.volumeUsageAdapter as ResourceAdapter,
    usage.databaseUsageAdapter as ResourceAdapter,
    usage.usagePeriodAdapter as ResourceAdapter,
  ];
  return new Map(all.map((adapter) => [adapter.kind, adapter]));
}
