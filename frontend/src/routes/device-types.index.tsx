import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type DeviceType, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { ImportBundleDialog } from "@/components/device-bundle"
import { buildDeviceTypeColumns } from "@/components/columns/device-type-columns"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { DeviceTypeDeleteDialog } from "@/components/device-type-delete-dialog"
import { DeviceTypeImportDialog } from "@/components/device-type-import-dialog"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/device-types/")({
  component: DeviceTypesPage,
})

function DeviceTypesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("devicetype", "add")
  const canEdit = canDo("devicetype", "change")
  const canDelete = canDo("devicetype", "delete")
  const [q, setQ] = useState("")
  const [mfrFilter, setMfrFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<DeviceType | null>(null)
  const [importing, setImporting] = useState(false)
  const [importingBundle, setImportingBundle] = useState(false)

  const query = useQuery({
    queryKey: ["device-types", q],
    queryFn: () =>
      api<Paginated<DeviceType>>(
        `/api/device-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter(
        (d) =>
          mfrFilter.size === 0 ||
          (d.manufacturer && mfrFilter.has(d.manufacturer.id))
      ),
    [allRows, mfrFilter]
  )

  const facets = useMemo(() => {
    const c: Record<string, { name: string; count: number }> = {}
    for (const d of allRows) {
      const key = d.manufacturer?.id ?? "none"
      const name = d.manufacturer?.name ?? "No manufacturer"
      if (!c[key]) c[key] = { name, count: 0 }
      c[key].count++
    }
    return Object.entries(c)
      .sort(([, a], [, b]) => b.count - a.count)
      .map<FacetOption>(([id, v]) => ({
        value: id,
        label: v.name,
        count: v.count,
      }))
  }, [allRows])

  const handleDelete = useCallback((d: DeviceType) => setDeleting(d), [])
  const columns = useMemo<ColumnDef<DeviceType>[]>(
    () =>
      buildDeviceTypeColumns<DeviceType>({
        selection: true,
        humanIds,
        omit: ["part_number"],
        actions: {
          editTo: "/device-types/$id/edit",
          editParams: (d) => ({ id: d.id }),
          canEdit: (d) => objCan(d, "change", canEdit),
          onDelete: handleDelete,
          canDelete: (d) => objCan(d, "delete", canDelete),
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Device types"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Manufacturer"
            options={facets}
            selected={mfrFilter}
            onToggle={(v) => toggleInSet(mfrFilter, v, setMfrFilter)}
          />
        </FilterRail>
      }
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, model…",
      }}
      actions={
        <>
          <TableActions ioType="devicetype" />
          {canAdd && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImporting(true)}
              >
                Import CSV
              </Button>
              {/* A bundle is a whole configured model — templates, faceplate,
                  photo ports, sensors — not just catalog rows. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImportingBundle(true)}
              >
                Import bundle
              </Button>
              <Button size="sm" asChild>
                <Link to="/device-types/new">Add device type</Link>
              </Button>
            </>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="device-types"
      />
      <DeviceTypeDeleteDialog
        deviceType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <DeviceTypeImportDialog open={importing} onOpenChange={setImporting} />
      <ImportBundleDialog
        open={importingBundle}
        onOpenChange={setImportingBundle}
      />
    </ListPageShell>
  )
}
