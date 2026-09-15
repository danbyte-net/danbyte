import { Link } from "@tanstack/react-router"
import type { LinkProps } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { useTableFilters } from "@/components/table-filters"

// The routing catalogs (prefix lists, communities, community lists, AS-path
// lists, policies, keychains) are seven lists of the same shape. One page
// component draws them all from a spec; each keeps its own column factory.

export interface RoutingListSpec<T extends { id: string }> {
  title: string
  /** RBAC slug ("prefixlist") - also the IO type. */
  objectType: string
  endpoint: string
  queryKey: string
  tableId: string
  newTo: LinkProps["to"]
  addLabel: string
  searchPlaceholder: string
  /** Which text fields the header search box matches. */
  searchText: (row: T) => string
  flexColumn: string
  label: (row: T) => string
  columns: (o: {
    onDelete: (row: T) => void
    humanIds: boolean
    canEdit: boolean
    canDelete: boolean
  }) => ColumnDef<T, unknown>[]
}

export function RoutingDeleteDialog<T extends { id: string }>({
  item,
  endpoint,
  queryKey,
  label,
  onOpenChange,
  onDeleted,
}: {
  item: T | null
  endpoint: string
  queryKey: string
  label: (row: T) => string
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`${endpoint}${item!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${label(item!)}`)
      qc.invalidateQueries({ queryKey: [queryKey] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!item} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {item ? label(item) : ""}?</AlertDialogTitle>
          <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function RoutingListPage<T extends { id: string }>({
  spec,
}: {
  spec: RoutingListSpec<T>
}) {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo(spec.objectType, "add")
  const canEdit = canDo(spec.objectType, "change")
  const canDelete = canDo(spec.objectType, "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<T | null>(null)

  const query = useQuery({
    queryKey: [spec.queryKey],
    queryFn: () => api<Paginated<T>>(`${spec.endpoint}?page_size=500`),
  })

  const allRows = useMemo(() => query.data?.results ?? [], [query.data])
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allRows
    return allRows.filter((r) => spec.searchText(r).toLowerCase().includes(n))
  }, [allRows, q, spec])

  const onDelete = useCallback((r: T) => setDeleting(r), [])
  const columns = useMemo(
    () => spec.columns({ onDelete, humanIds, canEdit, canDelete }),
    [spec, onDelete, humanIds, canEdit, canDelete]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wired,
  } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title={spec.title}
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: spec.objectType,
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: spec.searchPlaceholder }}
      actions={
        <>
          <TableActions ioType={spec.objectType} />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to={spec.newTo}>{spec.addLabel}</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wired}
        flexColumn={spec.flexColumn}
        tableId={spec.tableId}
      />
      <RoutingDeleteDialog
        item={deleting}
        endpoint={spec.endpoint}
        queryKey={spec.queryKey}
        label={spec.label}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
