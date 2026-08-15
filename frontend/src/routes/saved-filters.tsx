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
import { ExpressionEditor } from "@/components/filter-expression"
import type { FilterSnapshot } from "@/components/table-filters"
import { X } from "lucide-react"

export const Route = createFileRoute("/saved-filters")({
  validateSearch: (s: Record<string, unknown>): { edit?: string } => ({
    ...(typeof s.edit === "string" ? { edit: s.edit } : {}),
  }),
  component: SavedFiltersPage,
})

/** RBAC object slug → the list page it filters. Unknown slugs render as
 * plain text — the filter still edits and deletes fine. */
const LISTS: Record<string, { label: string; to: string; api: string }> = {
  cable: { label: "Cables", to: "/cables", api: "/api/cables/" },
  certificate: {
    label: "Certificates",
    to: "/certificates",
    api: "/api/monitoring/certificates/",
  },
  certificaterequest: {
    label: "Certificate requests",
    to: "/certificate-requests",
    api: "/api/monitoring/certificate-requests/",
  },
  circuit: { label: "Circuits", to: "/circuits", api: "/api/circuits/" },
  circuittype: {
    label: "Circuit types",
    to: "/circuit-types",
    api: "/api/circuit-types/",
  },
  cluster: { label: "Clusters", to: "/clusters", api: "/api/clusters/" },
  clustergroup: {
    label: "Cluster groups",
    to: "/cluster-groups",
    api: "/api/cluster-groups/",
  },
  clustertype: {
    label: "Cluster types",
    to: "/cluster-types",
    api: "/api/cluster-types/",
  },
  device: { label: "Devices", to: "/devices", api: "/api/devices/" },
  devicerole: {
    label: "Device roles",
    to: "/device-roles",
    api: "/api/device-roles/",
  },
  devicetype: {
    label: "Device types",
    to: "/device-types",
    api: "/api/device-types/",
  },
  ipaddress: { label: "IP addresses", to: "/ips", api: "/api/ips/" },
  ipsecprofile: {
    label: "IPsec profiles",
    to: "/ipsec-profiles",
    api: "/api/ipsec-profiles/",
  },
  location: { label: "Locations", to: "/locations", api: "/api/locations/" },
  macaddress: { label: "MAC addresses", to: "/macs", api: "/api/macs/" },
  maintenanceevent: {
    label: "Maintenance",
    to: "/maintenance",
    api: "/api/monitoring/maintenance-events/",
  },
  manufacturer: {
    label: "Manufacturers",
    to: "/manufacturers",
    api: "/api/manufacturers/",
  },
  platform: { label: "Platforms", to: "/platforms", api: "/api/platforms/" },
  platformgroup: {
    label: "Platform groups",
    to: "/platform-groups",
    api: "/api/platform-groups/",
  },
  powerfeed: {
    label: "Power feeds",
    to: "/power-feeds",
    api: "/api/power-feeds/",
  },
  powerpanel: {
    label: "Power panels",
    to: "/power-panels",
    api: "/api/power-panels/",
  },
  prefix: { label: "Prefixes", to: "/prefixes", api: "/api/prefixes/" },
  provider: { label: "Providers", to: "/providers", api: "/api/providers/" },
  providernetwork: {
    label: "Provider networks",
    to: "/provider-networks",
    api: "/api/provider-networks/",
  },
  rack: { label: "Racks", to: "/racks", api: "/api/racks/" },
  rackrole: { label: "Rack roles", to: "/rack-roles", api: "/api/rack-roles/" },
  service: { label: "Services", to: "/services", api: "/api/services/" },
  servicetemplate: {
    label: "Service templates",
    to: "/service-templates",
    api: "/api/service-templates/",
  },
  site: { label: "Sites", to: "/sites", api: "/api/sites/" },
  tenant: { label: "Tenants", to: "/tenants", api: "/api/tenants/" },
  tunnel: { label: "Tunnels", to: "/tunnels", api: "/api/tunnels/" },
  tunnelgroup: {
    label: "Tunnel groups",
    to: "/tunnel-groups",
    api: "/api/tunnel-groups/",
  },
  virtualchassis: {
    label: "Virtual chassis",
    to: "/virtual-chassis",
    api: "/api/virtual-chassis/",
  },
  virtualmachine: {
    label: "Virtual machines",
    to: "/virtual-machines",
    api: "/api/virtual-machines/",
  },
  vlan: { label: "VLANs", to: "/vlans", api: "/api/vlans/" },
  vlangroup: {
    label: "VLAN groups",
    to: "/vlan-groups",
    api: "/api/vlan-groups/",
  },
  wirelesslan: {
    label: "Wireless LANs",
    to: "/wireless-lans",
    api: "/api/wireless-lans/",
  },
  wirelesslangroup: {
    label: "Wireless LAN groups",
    to: "/wireless-lan-groups",
    api: "/api/wireless-lan-groups/",
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
  const [searchText, setSearchText] = useState(view.query.q ?? "")

  // A small sample of the target list feeds the expression editor's field
  // dropdown and value pickers — same discovery the list dialog uses.
  const sample = useQuery({
    queryKey: ["saved-filter-sample", view.object_type],
    queryFn: () =>
      api<Paginated<unknown>>(`${LISTS[view.object_type]?.api}?page_size=25`),
    enabled: !!LISTS[view.object_type],
    staleTime: 5 * 60_000,
  })

  const storedFacets: FilterSnapshot = view.query.facets ?? {}
  const initialExpr =
    typeof storedFacets.__expr === "string" ? storedFacets.__expr : ""
  const [expr, setExpr] = useState<{ text: string; error: string | null }>({
    text: initialExpr,
    error: null,
  })
  // Facet selections, editable as removable values — their labels live on the
  // source list, so this edits what was saved rather than offering new picks.
  const [facets, setFacets] = useState<FilterSnapshot>(() => {
    const rest: FilterSnapshot = {}
    for (const [k, v] of Object.entries(storedFacets))
      if (k !== "__expr") rest[k] = v
    return rest
  })

  const dropFacetValue = (key: string, value?: string) => {
    setFacets((cur) => {
      const next: FilterSnapshot = { ...cur }
      const entry = next[key]
      if (value !== undefined && Array.isArray(entry)) {
        const left = entry.filter((v) => v !== value)
        if (left.length) next[key] = left
        else delete next[key]
      } else {
        delete next[key]
      }
      return next
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const outFacets: FilterSnapshot = { ...facets }
      if (expr.text.trim()) outFacets.__expr = expr.text.trim()
      return api<SavedView>(`/api/saved-filters/${view.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          shared,
          query: { q: searchText, facets: outFacets },
        }),
      })
    },
    onSuccess: () => {
      toast.success("Saved filter updated")
      qc.invalidateQueries({ queryKey: ["saved-views"] })
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  const facetEntries = Object.entries(facets)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Edit saved filter</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Description
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Search text</label>
            <Input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="What the list's search box contains"
            />
          </div>

          {facetEntries.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Sidebar selections
              </label>
              <div className="space-y-1.5 rounded-lg border border-border p-2.5">
                {facetEntries.map(([key, entry]) => (
                  <div
                    key={key}
                    className="flex flex-wrap items-center gap-1.5 text-[12px]"
                  >
                    <span className="font-mono text-muted-foreground">
                      {key}
                    </span>
                    {Array.isArray(entry) ? (
                      entry.map((v) => (
                        <span
                          key={v}
                          className="inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5"
                        >
                          <span className="max-w-48 truncate">{v}</span>
                          <button
                            type="button"
                            title="Remove this value"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={() => dropFacetValue(key, v)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5">
                        {typeof entry === "string"
                          ? entry
                          : `${entry.min || "…"} – ${entry.max || "…"}`}
                        <button
                          type="button"
                          title="Remove"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => dropFacetValue(key)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Ticked sidebar facets, by internal value — remove what no
                  longer belongs; add new ones from the list itself.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">
              Advanced expression
            </label>
            <ExpressionEditor
              initial={initialExpr}
              rows={sample.data?.results ?? []}
              onChange={(text, error) => setExpr({ text, error })}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={shared}
              onCheckedChange={(v) => setShared(!!v)}
            />
            Share with everyone in this tenant
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || !!expr.error || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
