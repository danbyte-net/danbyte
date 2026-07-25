import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  Check,
  EyeOff,
  Link2 as LinkIcon,
  Plus,
  RefreshCw,
  X,
} from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated, SnmpDriftItem } from "@/lib/api"
import { DriftDescription, driftKey } from "@/components/drift-detail"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
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
    // Accepting part drift writes a part's status: the Hardware table, the
    // photo faceplate and the 3D rack all read that, so they must re-ask too.
    qc.invalidateQueries({ queryKey: ["device-inventory", deviceId] })
    qc.invalidateQueries({ queryKey: ["device-face-ports", deviceId] })
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

  // "This port can never be polled" — flag it once instead of dismissing the
  // same stale row after every poll. Sets Interface.snmp_ignore.
  const ignore = useMutation({
    mutationFn: (it: { interface_id: string }) =>
      api(`/api/interfaces/${it.interface_id}/`, {
        method: "PATCH",
        body: JSON.stringify({ snmp_ignore: true }),
      }),
    onSuccess: () => {
      toast.success(
        "Excluded from SNMP drift — undo on the interface's edit form."
      )
      qc.invalidateQueries({ queryKey: ["device-snmp-drift", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-interfaces", deviceId] })
      qc.invalidateQueries({ queryKey: ["interfaces"] })
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
            {/* A discovered interface is often a port you already labelled by
                its silkscreen ("Ethernet 1" reporting as "eth0"). Linking the
                pair collapses the phantom new/missing rows into one row. */}
            {canApply && item.kind === "interface_missing" && item.name && (
              <LinkInterfaceButton
                deviceId={deviceId}
                snmpName={item.name}
                disabled={busy}
              />
            )}
            {/* A stale row for a port the agent can never report — exclude it
                once, instead of dismissing the same row after every poll. */}
            {canApply && item.kind === "interface_stale" && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={busy || ignore.isPending}
                title="This port can't be polled — stop flagging it as drift"
                onClick={() => ignore.mutate(item)}
              >
                <EyeOff className="h-3.5 w-3.5" /> Exclude
              </Button>
            )}
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

/**
 * "Link to…" — record that a discovered SNMP name belongs to an interface the
 * user already created. Lists the device's interfaces (unlinked first) and
 * writes the link, so the pair stops drifting as both new and missing.
 */
function LinkInterfaceButton({
  deviceId,
  snmpName,
  disabled,
}: {
  deviceId: string
  snmpName: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()

  const ifaces = useQuery({
    queryKey: ["interfaces", deviceId],
    queryFn: () =>
      api<Paginated<{ id: string; name: string; snmp_name: string }>>(
        `/api/interfaces/?device=${deviceId}&page_size=500`
      ),
    enabled: open,
  })

  const link = useMutation({
    mutationFn: (interfaceId: string) =>
      api(`/api/monitoring/devices/${deviceId}/snmp/link-interface/`, {
        method: "POST",
        body: JSON.stringify({
          interface_id: interfaceId,
          snmp_name: snmpName,
        }),
      }),
    onSuccess: () => {
      toast.success(`Linked ${snmpName}`)
      qc.invalidateQueries({ queryKey: ["device-snmp-drift", deviceId] })
      qc.invalidateQueries({ queryKey: ["interfaces", deviceId] })
      qc.invalidateQueries({ queryKey: ["device-interfaces", deviceId] })
      setOpen(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  // Ports with no SNMP name yet are the likely match, so they lead; ports that
  // already carry one are still listed (picking one moves the name over).
  const rows = ifaces.data?.results ?? []
  const sections = [
    { heading: "Not linked", items: rows.filter((i) => !i.snmp_name) },
    { heading: "Already linked", items: rows.filter((i) => i.snmp_name) },
  ].filter((s) => s.items.length > 0)

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={disabled}
          title={`Link "${snmpName}" to an interface you already created`}
        >
          <LinkIcon className="h-3.5 w-3.5" /> Link to…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput
            placeholder={`${snmpName} is really…`}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>
              {ifaces.isLoading ? "Loading…" : "No interfaces match."}
            </CommandEmpty>
            {sections.map((section) => (
              <CommandGroup key={section.heading} heading={section.heading}>
                {section.items.map((i) => (
                  <CommandItem
                    key={i.id}
                    value={`${i.name} ${i.snmp_name}`}
                    disabled={link.isPending}
                    onSelect={() => link.mutate(i.id)}
                    className="gap-2"
                  >
                    <span className="truncate font-mono">{i.name}</span>
                    {i.snmp_name && (
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                        ↔ {i.snmp_name}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
