import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, Trash2 } from "lucide-react"
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
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { DhcpReservationDialog } from "@/components/integrations/dhcp-reservation-dialog"
import { dash } from "@/components/kv-card"
import { useFacetRail } from "@/lib/use-facet-rail"

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
  const [q, setQ] = useState("")
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<DhcpReservation | null>(null)

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

  const columns = useMemo<ColumnDef<DhcpReservation>[]>(
    () => [
      {
        id: "ip",
        accessorKey: "ip",
        header: ({ column }) => <SortHeader column={column} label="IP" />,
        cell: ({ row }) =>
          row.original.ip_address ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.ip_address }}
              className="link font-mono text-xs"
            >
              {row.original.ip}
            </Link>
          ) : (
            <span className="font-mono text-xs">{row.original.ip}</span>
          ),
      },
      {
        id: "mac",
        accessorKey: "mac",
        header: ({ column }) => <SortHeader column={column} label="MAC" />,
        cell: ({ row }) => (
          <Link
            to="/macs/$mac"
            params={{ mac: row.original.mac }}
            className="link font-mono text-[11px]"
          >
            {row.original.mac}
          </Link>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => row.original.name || dash,
      },
      {
        id: "scope",
        accessorKey: "scope_display",
        header: ({ column }) => <SortHeader column={column} label="Scope" />,
        // Scopes have no detail page — the informative destination is the
        // prefix the scope backs in IPAM.
        cell: ({ row }) =>
          row.original.scope_prefix ? (
            <Link
              to="/prefixes/$id"
              params={{ id: row.original.scope_prefix }}
              className="link font-mono text-[11px]"
            >
              {row.original.scope_display}
            </Link>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">
              {row.original.scope_display}
            </span>
          ),
      },
      {
        id: "server",
        accessorKey: "connection_name",
        header: ({ column }) => <SortHeader column={column} label="Server" />,
        cell: ({ row }) =>
          row.original.connection ? (
            <Link
              to="/windows-servers/$id"
              params={{ id: row.original.connection }}
              className="link text-xs"
            >
              {row.original.connection_name}
            </Link>
          ) : (
            <span
              className="text-xs text-muted-foreground"
              title="Reservation in a local (Danbyte-owned) scope"
            >
              Local
            </span>
          ),
      },
      {
        id: "origin",
        header: "Origin",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.managed ? (
            <Badge variant="outline" className="text-[10px]">
              Danbyte
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">server</span>
          ),
      },
      {
        id: "drift",
        header: "Drift",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.drift ? (
            <Badge variant="destructive" className="text-[10px]">
              {row.original.drift === "missing" ? "missing" : "modified"}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      ...(canChange || canDelete
        ? [
            {
              id: "actions",
              header: "",
              enableSorting: false,
              cell: ({ row }) => (
                <div className="flex justify-end gap-1">
                  {canChange && (
                    <Button
                      size="xs"
                      variant="ghost"
                      title="Edit reservation"
                      onClick={() => setEditing(row.original)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title="Delete reservation"
                      disabled={del.isPending}
                      onClick={() => del.mutate(row.original)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ),
            } satisfies ColumnDef<DhcpReservation>,
          ]
        : []),
    ],
    [canChange, canDelete, del]
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
        canAdd && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> Add reservation
          </Button>
        )
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
          Reservations from your Windows DHCP servers — and any you create on a
          server's page — appear here.
        </EmptyState>
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          tableId="dhcp-reservations-all"
        />
      )}
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
