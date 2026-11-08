import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DhcpReservation,
  type DhcpScope,
  type Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { buildDhcpReservationColumns } from "@/components/columns/dhcp-reservation-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { DhcpReservationDialog } from "@/components/integrations/dhcp-reservation-dialog"
import { useFacetRail } from "@/lib/use-facet-rail"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/dhcp-reservations/")({
  validateSearch: (s: Record<string, unknown>) => ({
    scope: typeof s.scope === "string" ? s.scope : undefined,
  }),
  component: DhcpReservationsPage,
})

const DRIFT_LABEL: Record<string, string> = {
  modified: "Modified on server",
  missing: "Missing on server",
}

function DhcpReservationsPage() {
  const { scope } = Route.useSearch()
  const { canDo } = useMe()
  const canAdd = canDo("dhcpreservation", "add")
  const canChange = canDo("dhcpreservation", "change")
  const canDelete = canDo("dhcpreservation", "delete")
  const qc = useQueryClient()
  const [q, setQ] = useUrlSearch()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<DhcpReservation | null>(null)
  const [selected, setSelected] = useState<DhcpReservation[]>([])
  const selectable = canChange || canDelete

  const scopesQ = useQuery({
    queryKey: ["dhcp-scopes", "picker"],
    queryFn: () => api<Paginated<DhcpScope>>("/api/dhcp-scopes/?page_size=500"),
    enabled: canAdd || canChange,
  })
  const del = useMutation({
    mutationFn: (r: DhcpReservation) =>
      api(`/api/dhcp-reservations/${r.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Reservation removed")
      qc.invalidateQueries({ queryKey: ["dhcp-reservations"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const query = useQuery({
    queryKey: ["dhcp-reservations", "all", q, scope ?? ""],
    queryFn: () => {
      const p = new URLSearchParams({ search: q })
      if (scope) p.set("scope", scope)
      return api<Paginated<DhcpReservation>>(
        `/api/dhcp-reservations/?${p}&page_size=500`
      )
    },
  })
  const rows = query.data?.results ?? []
  const scopeLabel = scope ? rows[0]?.scope_display : undefined

  const columns = useMemo(
    () =>
      buildDhcpReservationColumns<DhcpReservation>({
        selection: selectable,
        actions:
          canChange || canDelete
            ? {
                onEdit: canChange ? setEditing : undefined,
                onDelete: canDelete ? (r) => del.mutate(r) : undefined,
                deleteLabel: "Delete reservation",
              }
            : undefined,
      }),
    [canChange, canDelete, del, selectable]
  )

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "server",
      label: "Server",
      get: (r) => ({
        value: r.connection_name ?? "Local",
        label: r.connection_name ?? "Local",
      }),
    },
    {
      key: "origin",
      label: "Origin",
      get: (r) => ({
        value: r.managed ? "danbyte" : "server",
        label: r.managed ? "Danbyte" : "Server",
      }),
    },
    {
      key: "drift",
      label: "Drift",
      get: (r) => ({
        value: r.drift || "ok",
        label: r.drift ? DRIFT_LABEL[r.drift] : "In sync",
      }),
    },
  ])

  return (
    <ListPageShell
      title="DHCP reservations"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "IP, MAC or name…" }}
      actions={
        <>
          <TableActions ioType="dhcpreservation" />
          {canAdd && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Add reservation
            </Button>
          )}
        </>
      }
    >
      {scope && (
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">Scope {scopeLabel || scope}</Badge>
          <Button variant="ghost" size="sm" className="h-6 px-2" asChild>
            <Link to="/dhcp-reservations" search={{ scope: undefined }}>
              Clear
            </Link>
          </Button>
        </div>
      )}
      {rows.length === 0 && query.data && !q && !scope ? (
        <EmptyState title="No DHCP reservations synced.">
          Reservations from your Windows DHCP servers - and any you create on a
          server's page - appear here.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dhcp-reservations-all"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      {/* No bulk edit: an edit is pushed to the server one reservation at a
          time. */}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/dhcp-reservations/"
        noun={["reservation", "reservations"]}
        invalidate={[["dhcp-reservations"], ["dhcp-scopes"]]}
        onCleared={() => setSelected([])}
        canEdit={false}
        canDelete={canDelete}
        ioType="dhcpreservation"
      />
      {creating && (
        <DhcpReservationDialog
          scopes={scopesQ.data?.results ?? []}
          onOpenChange={(o) => !o && setCreating(false)}
        />
      )}
      {editing && (
        <DhcpReservationDialog
          scopes={scopesQ.data?.results ?? []}
          reservation={editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </ListPageShell>
  )
}
