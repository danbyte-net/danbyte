import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import { api, type Region, type Paginated } from "@/lib/api"
import { nestByParent } from "@/lib/nest"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildRegionColumns } from "@/components/columns/region-columns"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { ListPageShell } from "@/components/list-page-shell"
import { RegionDeleteDialog } from "@/components/region-delete-dialog"

export const Route = createFileRoute("/regions/")({ component: RegionsPage })

function RegionsPage() {
  const { humanIds } = useMe()
  const { canDo } = useMe()
  const canAdd = canDo("region", "add")
  const canEdit = canDo("region", "change")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Region | null>(null)
  const [sel, setSel] = useState<Region[]>([])

  const query = useQuery({
    queryKey: ["regions"],
    queryFn: () => api<Paginated<Region>>("/api/regions/"),
  })

  const allRows = query.data?.results ?? []
  // Filter first, then nest (issue #70): sub-regions group under their
  // parent, depth-first, and a filtered-out parent's children surface at
  // the root - the same tree treatment as the Locations and prefix lists.
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    const filtered = !n
      ? allRows
      : allRows.filter(
          (r) =>
            r.name.toLowerCase().includes(n) ||
            r.description.toLowerCase().includes(n)
        )
    return nestByParent(filtered)
  }, [allRows, q])

  const onDelete = useCallback((r: Region) => setDeleting(r), [])
  const columns = useMemo(
    () =>
      buildRegionColumns<Region>({
        selection: canEdit,
        humanIds,
        actions: {
          editTo: "/regions/$id/edit",
          editParams: (r) => ({ id: r.id }),
          onDelete,
        },
      }),
    [onDelete, humanIds, canEdit]
  )

  return (
    <ListPageShell
      title="Regions"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter regions…",
      }}
      actions={
        <>
          <TableActions ioType="region" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/regions/new">Add region</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="regions"
        onSelectedRowsChange={setSel}
      />
      <ComponentBulkBar
        endpoint="/api/regions/"
        kindLabel="region"
        selected={sel}
        onCleared={() => setSel([])}
        invalidate={[["regions"]]}
        canDelete={false}
        rename={false}
        clone={false}
        fields={[
          {
            key: "parent_id",
            label: "Parent region",
            kind: "object",
            object_model: "region",
          },
          { key: "color", label: "Marker colour", kind: "color" },
        ]}
      />
      <RegionDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
