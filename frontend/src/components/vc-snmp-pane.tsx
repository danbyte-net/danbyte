import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceSnmp, VcSnmpDrift } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { DeviceDriftCard } from "@/components/device-drift-card"
import { QueryError } from "@/components/query-error"

/**
 * The stack's SNMP tab: one poll through the owning member, then each member's
 * drift against its own slice of the observation (#148). Accepting or syncing
 * a member uses the per-device cards below, so the stack view and the device
 * view never disagree.
 */
export function VcSnmpPane({ vcId }: { vcId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canChange = canDo("device", "change")

  const q = useQuery({
    queryKey: ["vc-snmp-drift", vcId],
    queryFn: () =>
      api<VcSnmpDrift>(`/api/monitoring/virtual-chassis/${vcId}/snmp/drift/`),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["vc-snmp-drift", vcId] })
    qc.invalidateQueries({ queryKey: ["device-snmp"] })
    qc.invalidateQueries({ queryKey: ["device-snmp-drift"] })
    qc.invalidateQueries({ queryKey: ["vc-member-interfaces"] })
    qc.invalidateQueries({ queryKey: ["interfaces"] })
  }

  const poll = useMutation({
    mutationFn: () =>
      api<DeviceSnmp & { queued?: boolean; detail?: string }>(
        `/api/monitoring/virtual-chassis/${vcId}/snmp-poll/`,
        { method: "POST", body: JSON.stringify({}) }
      ),
    onSuccess: (data) => {
      invalidate()
      if (data.queued) toast.info(data.detail || "Queued on the site's Outpost")
      else if (data.reachable) toast.success("Polled the stack over SNMP")
      else toast.error(data.error || "The stack did not respond to SNMP")
    },
    onError: (e) => apiErrorToast(e),
  })

  const sync = useMutation({
    mutationFn: () =>
      api<{
        members: {
          device: { name: string }
          summary: { interfaces_created: number; interfaces_updated: number }
        }[]
      }>(`/api/monitoring/virtual-chassis/${vcId}/snmp/sync/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      invalidate()
      const created = r.members.reduce(
        (n, m) => n + m.summary.interfaces_created,
        0
      )
      const updated = r.members.reduce(
        (n, m) => n + m.summary.interfaces_updated,
        0
      )
      toast.success(
        created || updated
          ? `Synced ${r.members.length} members - ${created} added, ${updated} updated`
          : "Every member is in sync with SNMP"
      )
    },
    onError: (e) => apiErrorToast(e),
  })

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  if (!q.data) return null
  const { owner, state, members } = q.data

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-[13px]">
        {state ? (
          state.reachable ? (
            <Badge variant="success">reachable</Badge>
          ) : (
            <Badge variant="destructive">unreachable</Badge>
          )
        ) : (
          <Badge variant="secondary">not polled</Badge>
        )}
        {owner && (
          <span className="text-muted-foreground">
            Polled through{" "}
            <Link
              to="/devices/$id"
              params={{ id: owner.id }}
              className="link font-mono"
            >
              {owner.name}
            </Link>
          </span>
        )}
        {state?.polled_at && (
          <span className="text-muted-foreground">
            <TimeCell iso={state.polled_at} />
          </span>
        )}
        {state?.error && !state.reachable && (
          <span className="text-destructive">{state.error}</span>
        )}
        {canChange && (
          <span className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={poll.isPending || !owner}
              onClick={() => poll.mutate()}
            >
              <RefreshCw
                className={
                  "h-3.5 w-3.5 " + (poll.isPending ? "animate-spin" : "")
                }
              />
              Poll stack
            </Button>
            <Button
              size="sm"
              disabled={sync.isPending || !state}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? "Syncing..." : "Sync stack from SNMP"}
            </Button>
          </span>
        )}
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The stack has no members.
        </p>
      ) : (
        members.map((m) => (
          <section key={m.device.id} className="space-y-2">
            <h3 className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              <span className="num inline-flex h-5 w-5 items-center justify-center rounded-sm border border-border text-[11px]">
                {m.device.vc_position ?? "-"}
              </span>
              <Link
                to="/devices/$id"
                params={{ id: m.device.id }}
                className="link font-mono tracking-normal normal-case"
              >
                {m.device.name}
              </Link>
              {m.device.is_master && <Badge variant="secondary">master</Badge>}
              <Badge variant={m.drift.length ? "warning" : "secondary"}>
                {m.drift.length} drift
              </Badge>
            </h3>
            <DeviceDriftCard deviceId={m.device.id} />
          </section>
        ))
      )}
    </div>
  )
}
