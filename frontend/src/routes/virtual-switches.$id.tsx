import { createFileRoute, Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Plus, X } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Interface,
  type Paginated,
  type VirtNetwork,
  type VirtualSwitch,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { DevicePicker } from "@/components/device-picker"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { VlanBadge } from "@/components/cells/vlan-badge"
import { useUrlTab } from "@/lib/use-url-tab"

export const Route = createFileRoute("/virtual-switches/$id")({
  component: VirtualSwitchDetail,
})

function VirtualSwitchDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["virtual-switch", id],
    queryFn: () => api<VirtualSwitch>(`/api/virtual-switches/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body sw={q.data} />
}

function Body({ sw }: { sw: VirtualSwitch }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "networks" | "journal" | "history"
  >("overview")
  const networks = useQuery({
    queryKey: ["virt-networks", { vswitch: sw.id }],
    queryFn: () =>
      api<Paginated<VirtNetwork>>(`/api/virt-networks/?vswitch=${sw.id}`),
  })
  const nets = networks.data?.results ?? []
  const rows: KvRow[] = [
    {
      label: "Kind",
      value: sw.kind_display ? (
        <Badge variant="outline" className="text-[10px]">
          {sw.kind_display}
        </Badge>
      ) : (
        dash
      ),
    },
    {
      label: "Cluster",
      value: sw.cluster ? (
        <Link
          to="/clusters/$id"
          params={{ id: sw.cluster.id }}
          className="link"
        >
          {sw.cluster.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Uplinks",
      value: sw.uplinks ? (
        <span className="font-mono text-xs">{sw.uplinks}</span>
      ) : (
        dash
      ),
    },
    {
      label: "MTU",
      value: sw.mtu != null ? <span className="num">{sw.mtu}</span> : dash,
    },
    { label: "Source", value: sw.created_switch ? "Synced" : "Manual" },
    { label: "Created", value: <TimeCell iso={sw.created_at} /> },
    { label: "Updated", value: <TimeCell iso={sw.updated_at} /> },
  ]

  return (
    <DetailShell
      backTo="/virtual-switches"
      backLabel="Virtual switches"
      title={sw.name}
      presence={{ type: "virtualswitch", id: sw.id }}
      hero={
        <DetailHero
          title={sw.name}
          description={sw.description}
          statCols={1}
          stats={
            <DetailStat
              label="Kind"
              value={<span className="text-xs">{sw.kind_display || "—"}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "networks", label: "Networks", count: nets.length },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <KvCard title="Virtual switch" rows={rows} />
          </div>
          <SwitchUplinks sw={sw} />
        </div>
      </DetailTab>
      <DetailTab value="networks">
        <SwitchNetworks nets={nets} loading={networks.isLoading} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.virtualswitch" objectId={sw.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.virtualswitch" objectId={sw.id} />
      </DetailTab>
    </DetailShell>
  )
}

/** Physical uplinks — the real host NICs (device interfaces) that carry this
 * switch, the "Physical Adapters" of the vCenter picture. Links switch → real
 * device I/O; each uplink traces on to its cabled port. Editable inline. */
function SwitchUplinks({ sw }: { sw: VirtualSwitch }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canEdit = canDo("virtualswitch", "change")
  const [device, setDevice] = useState<string | null>(null)
  const [iface, setIface] = useState("")

  const ifaces = useQuery({
    queryKey: ["device-interfaces", device],
    queryFn: () =>
      api<Paginated<Interface>>(`/api/interfaces/?device=${device}`),
    enabled: !!device,
  })
  const save = useMutation({
    mutationFn: (ids: string[]) =>
      api(`/api/virtual-switches/${sw.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ uplink_interface_ids: ids }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["virtual-switch", sw.id] })
      toast.success("Uplinks updated")
      setDevice(null)
      setIface("")
    },
    onError: (e) => apiErrorToast(e),
  })

  const current = sw.uplink_interfaces
  const currentIds = current.map((u) => u.id)

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Uplinks · physical adapters
      </h2>
      {current.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No physical NICs linked. Assign the hypervisor host's real interfaces
          below so this switch traces through to actual device I/O.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {current.map((u) => (
            <span
              key={u.id}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs"
            >
              <Link
                to="/devices/$id"
                params={{ id: u.device.id }}
                className="link text-muted-foreground"
              >
                {u.device.name}
              </Link>
              <span className="text-muted-foreground">/</span>
              <Link
                to="/interfaces/$id"
                params={{ id: u.id }}
                className="link font-mono"
              >
                {u.name}
              </Link>
              {canEdit && (
                <button
                  type="button"
                  aria-label="Remove uplink"
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate(currentIds.filter((id) => id !== u.id))
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-56">
            <DevicePicker
              label="Host device"
              value={device}
              onChange={(v) => {
                setDevice(v)
                setIface("")
              }}
            />
          </div>
          {device && (
            <Select value={iface} onValueChange={setIface}>
              <SelectTrigger size="sm" className="h-9 w-52 text-xs">
                <SelectValue placeholder="Interface…" />
              </SelectTrigger>
              <SelectContent>
                {(ifaces.data?.results ?? [])
                  .filter((i) => !currentIds.includes(i.id))
                  .map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!iface || save.isPending}
            onClick={() => iface && save.mutate([...currentIds, iface])}
          >
            <Plus className="h-3.5 w-3.5" /> Add uplink
          </Button>
        </div>
      )}
    </section>
  )
}

/** The networks (port-groups / bridges) on this switch as a table — each with
 * its VLAN and the VMs attached (the switch→network→VM chain). */
function SwitchNetworks({
  nets,
  loading,
}: {
  nets: VirtNetwork[]
  loading: boolean
}) {
  const columns = useMemo<ColumnDef<VirtNetwork>[]>(
    () => [
      {
        id: "network",
        accessorFn: (r) => r.name || r.ext_key,
        header: "Network",
        cell: ({ row }) => (
          <span className="font-medium">
            {row.original.name || row.original.ext_key}
          </span>
        ),
      },
      {
        id: "vlan",
        accessorFn: (r) => r.vlan?.vlan_id ?? "",
        header: "VLAN",
        cell: ({ row }) =>
          row.original.vlan ? (
            <VlanBadge vlan={row.original.vlan} />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: "vms",
        header: "Virtual machines",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.vms.length === 0 ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {row.original.vms.map((vm) => (
                <Link
                  key={vm.id}
                  to="/virtual-machines/$id"
                  params={{ id: vm.id }}
                  className="link rounded-md border border-border px-2 py-0.5 text-xs"
                >
                  {vm.name}
                </Link>
              ))}
            </div>
          ),
      },
    ],
    []
  )

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (nets.length === 0)
    return (
      <EmptyState title="No networks on this switch yet.">
        Networks appear once a sync with{" "}
        <span className="font-medium">virtual switches &amp; networks</span>{" "}
        enabled has run — each port-group/bridge is mapped to a VLAN and the VMs
        on it are linked here.
      </EmptyState>
    )
  return (
    <DataTable
      data={nets}
      columns={columns}
      tableId="switch-networks"
      flexColumn="vms"
      embedded
    />
  )
}
