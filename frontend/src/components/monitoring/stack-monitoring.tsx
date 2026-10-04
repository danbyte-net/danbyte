import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SlaStatusResponse } from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { DeviceChecksPanel } from "./device-checks-panel"
import { ObjectSlaPanel } from "./sla-add"

/**
 * A stack's Monitoring tab: the agreements it is in, then the checks of the
 * member that stands for it - the master when it has a primary IP, else the
 * first member by position that does. The other members are measured
 * through it; their own checks are on their device pages.
 */
export function StackMonitoring({ vcId }: { vcId: string }) {
  // The same request (and cache entry) as the SLA panel above it.
  const q = useQuery({
    queryKey: ["sla-status", "vc", [vcId], "object"],
    queryFn: () =>
      api<SlaStatusResponse>("/api/monitoring/sla-status/", {
        method: "POST",
        body: JSON.stringify({ kind: "vc", ids: [vcId] }),
      }),
  })
  const entry = q.data?.results[vcId]
  const measured = entry?.measured
  return (
    <div className="space-y-6">
      <ObjectSlaPanel objectType="api.virtualchassis" objectId={vcId} />
      {q.isLoading ? (
        <Loading />
      ) : !entry ? null : measured ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Measured on{" "}
            <Link
              to="/devices/$id"
              params={{ id: measured.device.id }}
              className="link"
            >
              {measured.device.name}
            </Link>
            {measured.ip && (
              <>
                {" · "}
                <Link
                  to="/ips/$id"
                  params={{ id: measured.ip.id }}
                  className="link font-mono"
                >
                  {measured.ip.address}
                </Link>
              </>
            )}
          </p>
          <DeviceChecksPanel deviceId={measured.device.id} />
        </div>
      ) : (
        <EmptyState title="No member with a primary IP.">
          A stack is measured on its master&apos;s primary IP, else the first
          member&apos;s that has one.
        </EmptyState>
      )}
    </div>
  )
}
