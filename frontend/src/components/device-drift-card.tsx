import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { Check, Plus, RefreshCw, X } from "lucide-react"

import { api } from "@/lib/api"
import type { SnmpDriftItem } from "@/lib/api"
import { DriftDescription, driftKey } from "@/components/drift-detail"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * Reconciliation inbox for a device (#84, Phase 3). Shows where the *observed*
 * SNMP state differs from the device's *intended* source of truth, and lets an
 * operator **accept** a difference — the only path by which discovery writes the
 * SoT — or **dismiss** it from view until the next poll.
 *
 * Accepting *creates what Danbyte is missing*: a new interface, a find-or-create
 * VLAN, an observed IP dropped into its containing prefix, or a first-class MAC
 * object. "Sync all" does the same in one shot across every drift item. Hidden
 * when there's no drift.
 */
export function DeviceDriftCard({ deviceId }: { deviceId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canApply = canDo("device", "change")

  const drift = useQuery({
    queryKey: ["device-snmp-drift", deviceId],
    queryFn: () =>
      api<{ drift: SnmpDriftItem[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/drift/`
      ),
  })

  // Client-side "dismiss until next poll": keeps a set of hidden rows, cleared
  // whenever the drift query yields fresh data (a poll / sync / accept), so a
  // dismissed-but-still-present difference resurfaces the next time we look.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  useEffect(() => {
    setDismissed(new Set())
  }, [drift.dataUpdatedAt])

  const invalidateSot = () => {
    // The SoT changed → refresh the device, its interfaces, and its IPs.
    qc.invalidateQueries({ queryKey: ["device", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-interfaces", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-ips", deviceId] })
    qc.invalidateQueries({ queryKey: ["interfaces"] })
  }

  const accept = useMutation({
    mutationFn: (action: SnmpDriftItem) =>
      api<{ drift: SnmpDriftItem[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/reconcile/`,
        { method: "POST", body: JSON.stringify({ action }) }
      ),
    onSuccess: (data) => {
      qc.setQueryData(["device-snmp-drift", deviceId], data)
      invalidateSot()
      toast.success("Applied — intent updated to match the network")
    },
    onError: (e) => apiErrorToast(e),
  })

  const sync = useMutation({
    mutationFn: () =>
      api<{
        interfaces_created: number
        interfaces_updated: number
        ips_assigned: number
        ips_skipped: number
        vlans_assigned: number
        drift: SnmpDriftItem[]
      }>(`/api/monitoring/devices/${deviceId}/snmp/sync/`, { method: "POST" }),
    onSuccess: (r) => {
      qc.setQueryData(["device-snmp-drift", deviceId], { drift: r.drift })
      invalidateSot()
      const bits = [
        r.interfaces_created && `${r.interfaces_created} interface(s) added`,
        r.interfaces_updated && `${r.interfaces_updated} updated`,
        r.ips_assigned && `${r.ips_assigned} IP(s) assigned`,
        r.vlans_assigned && `${r.vlans_assigned} VLAN(s) set`,
      ].filter(Boolean)
      toast.success(
        bits.length
          ? `Synced — ${bits.join(", ")}`
          : "Already in sync with SNMP"
      )
      if (r.ips_skipped)
        toast.info(
          `${r.ips_skipped} IP(s) skipped — no containing prefix (add the prefix, then sync again).`
        )
    },
    onError: (e) => apiErrorToast(e),
  })

  const all = drift.data?.drift ?? []
  const items = all.filter((it) => !dismissed.has(driftKey(it)))
  if (all.length === 0) return null

  const busy = accept.isPending || sync.isPending
  const columns: SimpleColumn<SnmpDriftItem>[] = [
    {
      id: "change",
      header: "Difference",
      flex: true,
      cell: (item) => <DriftDescription item={item} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (item) => {
        const noPrefix = item.kind === "ip_missing" && !item.has_prefix
        const canAccept =
          canApply && item.kind !== "interface_stale" && !noPrefix
        return (
          <div className="flex items-center justify-end gap-1">
            {noPrefix && (
              // No prefix contains this IP yet — offer to create one (pre-filled).
              <Button
                size="sm"
                variant="outline"
                asChild
                className="h-7"
                title="No prefix contains this address yet"
              >
                <Link
                  to="/prefixes/new"
                  search={{
                    cidr: item.suggested_prefix,
                    vrf: undefined,
                    site: undefined,
                    location: undefined,
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Add prefix
                </Link>
              </Button>
            )}
            {canAccept && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                disabled={busy}
                title="Accept — write this into the source of truth"
                aria-label="Accept difference"
                onClick={() => accept.mutate(item)}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              disabled={busy}
              title="Dismiss — hide until the next poll"
              aria-label="Dismiss difference"
              onClick={() =>
                setDismissed((prev) => new Set(prev).add(driftKey(item)))
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      },
    },
  ]

  return (
    <Section
      title="Drift"
      badge={<Badge variant="warning">{all.length}</Badge>}
      description="observed by SNMP, differs from the source of truth"
      actions={
        canApply && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => sync.mutate()}
            title="Accept every difference at once — create the interfaces, VLANs, IPs and MACs Danbyte is missing"
          >
            <RefreshCw
              className={
                "h-3.5 w-3.5 " + (sync.isPending ? "animate-spin" : "")
              }
            />
            Sync all
          </Button>
        )
      }
    >
      <SimpleTable
        columns={columns}
        data={items}
        getRowKey={(item) => driftKey(item)}
        empty="All differences dismissed — poll again to re-check."
      />
    </Section>
  )
}

/** A stable identity for a drift item, so we can track dismissals and keys. */
