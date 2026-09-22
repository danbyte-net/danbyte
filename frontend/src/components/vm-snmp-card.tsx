import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DeviceSnmp,
  type Paginated,
  type SnmpInterface,
  type VMInterface,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { IpLinks, MacLink } from "@/components/device-snmp-card"
import { EmptyState } from "@/components/empty-state"
import { KvCard, mono, dash, type KvRow } from "@/components/kv-card"
import { TimeCell } from "@/components/cells/time-ago"

const FACT_LABELS: Record<string, string> = {
  sys_name: "System name",
  sys_descr: "Description",
  sys_uptime: "Uptime",
  sys_contact: "Contact",
  sys_location: "Location",
}

/** SNMP poll + observed state for a virtual router / appliance (#13). A focused
 * counterpart to the device SNMP card: facts, interfaces, LLDP neighbours and
 * ARP polled by the VM's primary IP. */
export function VmSnmpCard({ vmId }: { vmId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canPoll = canDo("virtualmachine", "change")
  const base = `/api/monitoring/virtual-machines/${vmId}`

  const snmp = useQuery({
    queryKey: ["vm-snmp", vmId],
    queryFn: () => api<DeviceSnmp>(`${base}/snmp/`),
  })
  // The VM's own NICs, so an SNMP row can be read against the interface
  // Danbyte holds: by the hypervisor's name (`nic0`) or by the guest's SNMP
  // name set on the interface (`ether1`). Its addresses give the ARP table
  // something to link to.
  const nics = useQuery({
    queryKey: ["vm-interfaces", vmId],
    queryFn: () =>
      api<Paginated<VMInterface>>(`/api/vm-interfaces/?vm=${vmId}`),
  })
  const { ifaceByName, ipIdByAddr } = useMemo(() => {
    const byName = new Map<string, { id: string; name: string }>()
    const ips = new Map<string, string>()
    for (const i of nics.data?.results ?? []) {
      byName.set(i.name.toLowerCase(), { id: i.id, name: i.name })
      if (i.snmp_name) byName.set(i.snmp_name.toLowerCase(), { id: i.id, name: i.name })
      for (const ip of i.ip_addresses) ips.set(ip.ip_address, ip.id)
    }
    return { ifaceByName: byName, ipIdByAddr: ips }
  }, [nics.data])

  const poll = useMutation({
    mutationFn: () =>
      api<DeviceSnmp>(`${base}/snmp-poll/`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["vm-snmp", vmId], data)
      if (data.reachable) toast.success("Polled VM over SNMP")
      else toast.error(data.error || "VM did not respond to SNMP")
    },
    onError: (e) => apiErrorToast(e),
  })

  const ifColumns = useMemo<ColumnDef<SnmpInterface>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.name}</span>
        ),
      },
      {
        id: "danbyte",
        header: "Interface",
        cell: ({ row }) => {
          const hit =
            ifaceByName.get((row.original.name || "").toLowerCase()) ??
            ifaceByName.get((row.original.descr || "").toLowerCase())
          // A VM interface has no page of its own; the name is the mapping.
          return hit ? (
            <span className="font-mono text-xs">{hit.name}</span>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          )
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const up = row.original.oper_status === "up"
          return (
            <Badge
              variant={up ? "success" : "secondary"}
              className="text-[10px]"
            >
              {row.original.oper_status || "?"}
            </Badge>
          )
        },
      },
      {
        id: "speed",
        header: "Speed",
        cell: ({ row }) => {
          const m = Number(row.original.speed_mbps)
          return (
            <span className="num text-xs">
              {m > 0 ? (m >= 1000 ? `${m / 1000}G` : `${m}M`) : "-"}
            </span>
          )
        },
      },
      {
        id: "mac",
        header: "MAC",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.mac || "-"}
          </span>
        ),
      },
    ],
    [ifaceByName]
  )
  const arpColumns = useMemo<ColumnDef<DeviceSnmp["arp"][number]>[]>(
    () => [
      {
        id: "ip",
        header: "IP address",
        cell: ({ row }) => (
          <IpLinks ips={[row.original.ip]} idByAddr={ipIdByAddr} />
        ),
      },
      {
        id: "mac",
        header: "MAC",
        cell: ({ row }) => <MacLink mac={row.original.mac} />,
      },
      {
        id: "if",
        header: "ifIndex",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.if_index || "-"}
          </span>
        ),
      },
    ],
    [ipIdByAddr]
  )

  if (snmp.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>

  const state = snmp.data
  const facts = state?.data ?? {}
  const factRows: KvRow[] = Object.keys(facts).map((k) => ({
    label: FACT_LABELS[k] ?? k,
    value: mono(facts[k]),
    copy: facts[k],
  }))

  const PollButton = canPoll && (
    <Button
      size="sm"
      variant="outline"
      disabled={poll.isPending}
      onClick={() => poll.mutate()}
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {poll.isPending ? "Polling…" : "Poll now"}
    </Button>
  )

  if (!state?.polled_at)
    return (
      <EmptyState title="Not polled over SNMP yet.">
        <p>
          Poll this virtual router over SNMP (by its primary IP) to read its
          system facts and interfaces. It resolves an SNMP profile from the VM,
          its platform/cluster, or the tenant default.
        </p>
        <div className="mt-3">{PollButton}</div>
      </EmptyState>
    )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-sm">
          {state.reachable ? (
            <Badge variant="success">Reachable</Badge>
          ) : (
            <Badge variant="destructive">Unreachable</Badge>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          Last polled <TimeCell iso={state.polled_at} />
          {state.profile_name ? ` · ${state.profile_name}` : ""}
        </span>
        <span className="ml-auto">{PollButton}</span>
      </div>

      {state.error && <p className="text-xs text-destructive">{state.error}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard
          title="System"
          rows={factRows.length ? factRows : [{ label: "-", value: dash }]}
        />
      </div>

      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Interfaces
        </h2>
        {state.interfaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No interfaces reported.
          </p>
        ) : (
          <DataTable
            data={state.interfaces}
            columns={ifColumns}
            tableId="vm-snmp-interfaces"
            flexColumn="name"
            embedded
          />
        )}
      </section>

      {state.neighbors.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            LLDP neighbours
          </h2>
          <ul className="space-y-1 text-xs">
            {state.neighbors.map((n, i) => (
              <li key={i} className="font-mono">
                {n.local_port} → {n.remote_device} ({n.remote_port})
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.arp.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            ARP table
          </h2>
          <DataTable
            data={state.arp}
            columns={arpColumns}
            tableId="vm-snmp-arp"
            flexColumn="if"
            embedded
          />
        </section>
      )}
    </div>
  )
}
