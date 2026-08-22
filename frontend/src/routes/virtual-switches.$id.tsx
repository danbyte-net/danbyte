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
import { FormSelect } from "@/components/forms"
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

/** Sentinel for "no VRF of its own - inherit the switch, then the source".
 * The Select primitive disallows an empty string as an item value. */
const INHERIT = "__inherit__"

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
              value={<span className="text-xs">{sw.kind_display || "-"}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "networks", label: "Networks", count: nets.length },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
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
          <SwitchVrf sw={sw} />
        </div>
      </DetailTab>
      <DetailTab value="networks">
        <SwitchNetworks nets={nets} loading={networks.isLoading} sw={sw} />
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

/** Physical uplinks - the real host NICs (device interfaces) that carry this
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

/** The switch-wide routing context. A vSwitch trunks many VLANs, so this is a
 * default the networks on it can override - it decides which VRF's prefixes a
 * discovered address may land in, and is read live at sync time. */
function SwitchVrf({ sw }: { sw: VirtualSwitch }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canEdit = canDo("virtualswitch", "change")
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const save = useMutation({
    mutationFn: (vrfId: string | null) =>
      api(`/api/virtual-switches/${sw.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ vrf_id: vrfId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["virtual-switch", sw.id] })
      qc.invalidateQueries({ queryKey: ["virt-networks"] })
      toast.success("Routing context updated")
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        Address VRF
      </h2>
      <p className="mb-3 max-w-prose text-sm text-muted-foreground">
        Which VRF&rsquo;s prefixes a synced address on this switch may land in.
        Leave it empty to follow the sync source; a network below can override
        it.
      </p>
      <div className="max-w-xs">
        <FormSelect
          label="VRF"
          value={sw.vrf?.id ?? null}
          onChange={(v) => save.mutate(v ?? null)}
          noneLabel="Follow the sync source"
          disabled={!canEdit || save.isPending}
          options={(vrfs.data?.results ?? []).map((v) => ({
            value: v.id,
            label: v.name,
          }))}
        />
      </div>
    </section>
  )
}

/** The networks (port-groups / bridges) on this switch as a table - each with
 * its VLAN and the VMs attached (the switch→network→VM chain). */
function SwitchNetworks({
  nets,
  loading,
  sw,
}: {
  nets: VirtNetwork[]
  loading: boolean
  sw: VirtualSwitch
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canEdit = canDo("virtnetwork", "change")
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const setVrf = useMutation({
    mutationFn: ({ id, vrfId }: { id: string; vrfId: string | null }) =>
      api(`/api/virt-networks/${id}/`, {
        method: "PATCH",
        body: JSON.stringify({ vrf_id: vrfId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["virt-networks"] })
      toast.success("Routing context updated")
    },
    onError: (e) => apiErrorToast(e),
  })
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
            <span className="text-xs text-muted-foreground">-</span>
          ),
      },
      {
        id: "vrf",
        accessorFn: (r) => r.vrf?.name ?? "",
        header: "VRF",
        enableSorting: false,
        cell: ({ row }) => {
          const net = row.original
          const inherited = net.vrf?.inherited ?? false
          if (!canEdit)
            return net.vrf ? (
              <span className="text-xs">
                {net.vrf.name}
                {inherited && (
                  <span className="text-muted-foreground"> (switch)</span>
                )}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">-</span>
            )
          // Inline control, so the bare Select rather than FormSelect - a
          // labelled Field belongs in a form, not a table cell. An empty value
          // inherits, so the sentinel says what it inherits *to*.
          const inheritLabel = sw.vrf
            ? `Switch (${sw.vrf.name})`
            : "Follow the source"
          return (
            <Select
              value={net.vrf && !net.vrf.inherited ? net.vrf.id : INHERIT}
              onValueChange={(v) =>
                setVrf.mutate({
                  id: net.id,
                  vrfId: v === INHERIT ? null : v,
                })
              }
              disabled={setVrf.isPending}
            >
              <SelectTrigger size="sm" className="h-7 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
                {(vrfs.data?.results ?? []).map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        },
      },
      {
        id: "vms",
        header: "Virtual machines",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.vms.length === 0 ? (
            <span className="text-xs text-muted-foreground">-</span>
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
    [canEdit, sw.vrf, setVrf, vrfs.data]
  )

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (nets.length === 0)
    return (
      <EmptyState title="No networks on this switch yet.">
        Networks appear once a sync with{" "}
        <span className="font-medium">virtual switches &amp; networks</span>{" "}
        enabled has run - each port-group/bridge is mapped to a VLAN and the VMs
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
