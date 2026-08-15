import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Lock, Users } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type Paginated } from "@/lib/api"
import type { SavedView } from "@/components/saved-views"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/saved-filters")({
  validateSearch: (s: Record<string, unknown>): { edit?: string } => ({
    ...(typeof s.edit === "string" ? { edit: s.edit } : {}),
  }),
  component: SavedFiltersPage,
})

/** RBAC object slug → the list page it filters. Unknown slugs render as
 * plain text — the filter still edits and deletes fine. */
const LISTS: Record<string, { label: string; to: string }> = {
  cable: { label: "Cables", to: "/cables" },
  certificate: { label: "Certificates", to: "/certificates" },
  certificaterequest: {
    label: "Certificate requests",
    to: "/certificate-requests",
  },
  circuit: { label: "Circuits", to: "/circuits" },
  circuittype: { label: "Circuit types", to: "/circuit-types" },
  cluster: { label: "Clusters", to: "/clusters" },
  clustergroup: { label: "Cluster groups", to: "/cluster-groups" },
  clustertype: { label: "Cluster types", to: "/cluster-types" },
  device: { label: "Devices", to: "/devices" },
  devicerole: { label: "Device roles", to: "/device-roles" },
  devicetype: { label: "Device types", to: "/device-types" },
  ipaddress: { label: "IP addresses", to: "/ips" },
  ipsecprofile: { label: "IPsec profiles", to: "/ipsec-profiles" },
  location: { label: "Locations", to: "/locations" },
  macaddress: { label: "MAC addresses", to: "/macs" },
  maintenanceevent: { label: "Maintenance", to: "/maintenance" },
  manufacturer: { label: "Manufacturers", to: "/manufacturers" },
  platform: { label: "Platforms", to: "/platforms" },
  platformgroup: { label: "Platform groups", to: "/platform-groups" },
  powerfeed: { label: "Power feeds", to: "/power-feeds" },
  powerpanel: { label: "Power panels", to: "/power-panels" },
  prefix: { label: "Prefixes", to: "/prefixes" },
  provider: { label: "Providers", to: "/providers" },
  providernetwork: { label: "Provider networks", to: "/provider-networks" },
  rack: { label: "Racks", to: "/racks" },
  rackrole: { label: "Rack roles", to: "/rack-roles" },
  service: { label: "Services", to: "/services" },
  servicetemplate: { label: "Service templates", to: "/service-templates" },
  site: { label: "Sites", to: "/sites" },
  tenant: { label: "Tenants", to: "/tenants" },
  tunnel: { label: "Tunnels", to: "/tunnels" },
  tunnelgroup: { label: "Tunnel groups", to: "/tunnel-groups" },
  virtualchassis: { label: "Virtual chassis", to: "/virtual-chassis" },
  virtualmachine: { label: "Virtual machines", to: "/virtual-machines" },
  vlan: { label: "VLANs", to: "/vlans" },
  vlangroup: { label: "VLAN groups", to: "/vlan-groups" },
  wirelesslan: { label: "Wireless LANs", to: "/wireless-lans" },
  wirelesslangroup: {
    label: "Wireless LAN groups",
    to: "/wireless-lan-groups",
  },
}

const listLabel = (slug: string) => LISTS[slug]?.label ?? slug

function SavedFiltersPage() {
  const { edit } = Route.useSearch()
  const navigate = Route.useNavigate()
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [listFilter, setListFilter] = useState<Set<string>>(new Set())
  const [whoFilter, setWhoFilter] = useState<Set<string>>(new Set())

  const query = useQuery({
    queryKey: ["saved-views", "all"],
    queryFn: () =>
      api<Paginated<SavedView>>("/api/saved-filters/?page_size=500"),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter((v) => {
        if (
          q &&
          !`${v.name} ${v.description}`.toLowerCase().includes(q.toLowerCase())
        )
          return false
        if (listFilter.size > 0 && !listFilter.has(v.object_type)) return false
        if (whoFilter.size === 1) {
          if (whoFilter.has("mine") !== v.mine) return false
        }
        return true
      }),
    [allRows, q, listFilter, whoFilter]
  )

  const listFacets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const v of allRows) c[v.object_type] = (c[v.object_type] ?? 0) + 1
    return Object.entries(c)
      .map(([value, count]) => ({ value, label: listLabel(value), count }))
      .sort((a, b) => a.label.localeCompare(b.label)) as FacetOption[]
  }, [allRows])

  const whoFacets = useMemo(() => {
    const mine = allRows.filter((v) => v.mine).length
    return [
      { value: "mine", label: "Mine", count: mine },
      {
        value: "shared",
        label: "Shared with me",
        count: allRows.length - mine,
      },
    ].filter((o) => o.count) as FacetOption[]
  }, [allRows])

  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/saved-filters/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Saved filter deleted")
      qc.invalidateQueries({ queryKey: ["saved-views"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const openEdit = (id: string) =>
    navigate({ search: { edit: id }, replace: true })
  const closeEdit = () =>
    navigate({ search: (s) => ({ ...s, edit: undefined }), replace: true })
  const editing = edit ? allRows.find((v) => v.id === edit) : undefined

  const columns = useMemo<ColumnDef<SavedView>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="text-[13px] font-medium">{row.original.name}</span>
            {row.original.description && (
              <span className="truncate text-[11px] text-muted-foreground">
                {row.original.description}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "list",
        accessorFn: (v) => listLabel(v.object_type),
        header: ({ column }) => <SortHeader column={column} label="List" />,
        cell: ({ row }) => {
          const target = LISTS[row.original.object_type]
          return target ? (
            <Link to={target.to} className="hover:underline">
              {target.label}
            </Link>
          ) : (
            row.original.object_type
          )
        },
      },
      {
        id: "visibility",
        accessorFn: (v) => v.shared,
        header: "Visibility",
        cell: ({ row }) =>
          row.original.shared ? (
            <span className="inline-flex items-center gap-1 text-[12px]">
              <Users className="h-3 w-3 text-muted-foreground" /> Shared
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[12px]">
              <Lock className="h-3 w-3 text-muted-foreground" /> Private
            </span>
          ),
      },
      {
        id: "owner",
        accessorKey: "owner",
        header: ({ column }) => <SortHeader column={column} label="Owner" />,
        cell: ({ row }) => (row.original.mine ? "you" : row.original.owner),
      },
      timeAgoColumn<SavedView>({ get: (v) => v.updated_at }),
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={
              row.original.mine ? () => openEdit(row.original.id) : undefined
            }
            onDelete={
              row.original.mine ? () => del.mutate(row.original.id) : undefined
            }
          />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [del.mutate]
  )

  return (
    <ListPageShell
      title="Saved filters"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="List"
            options={listFacets}
            selected={listFilter}
            onToggle={(v) => toggleInSet(listFilter, v, setListFilter)}
          />
          <FacetGroup
            label="Owner"
            options={whoFacets}
            selected={whoFilter}
            onToggle={(v) => toggleInSet(whoFilter, v, setWhoFilter)}
          />
        </FilterRail>
      }
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="name"
        tableId="saved-filters"
      />
      <p className="px-1 pt-2 text-[11px] text-muted-foreground">
        Every saved view across every list — yours plus the ones shared with
        this tenant. Apply one from its own list page: the filter button next to
        the search box.
      </p>
      {editing && <EditDialog view={editing} onClose={closeEdit} />}
    </ListPageShell>
  )
}

function EditDialog({
  view,
  onClose,
}: {
  view: SavedView
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(view.name)
  const [description, setDescription] = useState(view.description)
  const [shared, setShared] = useState(view.shared)

  const save = useMutation({
    mutationFn: () =>
      api<SavedView>(`/api/saved-filters/${view.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          shared,
        }),
      }),
    onSuccess: () => {
      toast.success("Saved filter updated")
      qc.invalidateQueries({ queryKey: ["saved-views"] })
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Edit saved filter</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={shared}
              onCheckedChange={(v) => setShared(!!v)}
            />
            Share with everyone in this tenant
          </label>
          <p className="text-[11px] text-muted-foreground">
            The conditions themselves are edited on the list: apply this view
            there, adjust, and use Update.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
