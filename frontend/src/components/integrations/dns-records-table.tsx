import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { ApiError, api, type DnsRecord, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { FormText } from "@/components/forms"
import { DnsRecordDialog } from "@/components/integrations/dns-record-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** True when Windows DNS sync is enabled for the active tenant. Cached, so the
 * IPAM detail pages can cheaply decide whether to show a DNS tab/section. */
export function useDnsEnabled(): boolean {
  const q = useQuery({
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 5 * 60_000,
  })
  return !!q.data?.dns
}

const TYPE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  A: "default",
  AAAA: "default",
  PTR: "secondary",
}

/** Column factory for stored DNS records — reused by the zone page, the prefix
 * DNS tab, and the IP DNS section. `showZone` adds the zone column (off when a
 * table already scopes to one zone). */
export function dnsRecordColumns(showZone: boolean): ColumnDef<DnsRecord>[] {
  const cols: ColumnDef<DnsRecord>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.name}</span>
      ),
    },
    {
      id: "type",
      accessorKey: "record_type",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <Badge
          variant={TYPE_VARIANT[row.original.record_type] ?? "outline"}
          className="text-[10px]"
        >
          {row.original.record_type}
        </Badge>
      ),
    },
    {
      id: "data",
      accessorKey: "data",
      header: ({ column }) => <SortHeader column={column} label="Data" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.data}</span>
      ),
    },
    {
      id: "ip",
      header: "IP address",
      enableSorting: false,
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
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.ip} <span className="not-italic">· not in IPAM</span>
          </span>
        ),
    },
  ]
  if (showZone)
    cols.push({
      id: "zone",
      accessorKey: "zone_name",
      header: ({ column }) => <SortHeader column={column} label="Zone" />,
      cell: ({ row }) => (
        <Link
          to="/dns-zones/$id"
          params={{ id: row.original.zone }}
          className="link font-mono text-[11px] text-muted-foreground hover:text-foreground"
        >
          {row.original.zone_name}
        </Link>
      ),
    })
  return cols
}

/** A stored-DNS-records table. Either fetches from a query string
 * (zone/prefix/ip/…) or renders `rows` supplied by a faceted parent. */
export function DnsRecordsTable({
  params,
  queryKey,
  rows: providedRows,
  showZone = true,
  empty = "No DNS records.",
  tableId = "dns-records",
  editable = false,
}: {
  params?: string
  queryKey?: unknown[]
  /** When set, these rows are rendered instead of fetching (parent facets). */
  rows?: DnsRecord[]
  showZone?: boolean
  empty?: string
  tableId?: string
  /** Show edit/delete actions on authored (managed) records. */
  editable?: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canImport = canDo("ipaddress", "add")
  const canChange = canDo("dnsrecord", "change")
  const canDelete = canDo("dnsrecord", "delete")
  const [editRec, setEditRec] = useState<DnsRecord | null>(null)

  const del = useMutation({
    mutationFn: (rec: DnsRecord) =>
      api(`/api/dns-records/${rec.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Record deleted")
      qc.invalidateQueries({ queryKey: ["dns-records"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  const query = useQuery({
    queryKey: queryKey ?? ["dns-records", "unused"],
    queryFn: () =>
      api<Paginated<DnsRecord>>(`/api/dns-records/?${params}&page_size=500`),
    enabled: providedRows === undefined,
  })
  const rows = providedRows ?? query.data?.results ?? []

  // When an import fails only because no prefix contains the address, we open a
  // small "create prefix" dialog (pre-filled with a suggested CIDR) and retry.
  const [needPrefix, setNeedPrefix] = useState<{
    rec: DnsRecord
    cidr: string
  } | null>(null)

  const importOne = useMutation({
    mutationFn: (rec: DnsRecord) =>
      api<{ ok: boolean; error?: string }>(
        `/api/dns-records/${rec.id}/import/`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: () => {
      toast.success("Added to IPAM")
      qc.invalidateQueries({ queryKey: ["dns-records"] })
    },
    onError: (e, rec) => {
      const body =
        e instanceof ApiError ? (e.body as Record<string, unknown>) : null
      if (body?.reason === "no_prefix") {
        setNeedPrefix({ rec, cidr: String(body.suggested_prefix ?? "") })
      } else {
        apiErrorToast(e)
      }
    },
  })

  const createPrefix = useMutation({
    mutationFn: (cidr: string) =>
      api("/api/prefixes/", {
        method: "POST",
        body: JSON.stringify({ cidr }),
      }),
    onSuccess: () => {
      const rec = needPrefix?.rec
      setNeedPrefix(null)
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      toast.success("Prefix created")
      if (rec) importOne.mutate(rec) // retry the import into the new prefix
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo(() => {
    const cols = dnsRecordColumns(showZone)
    if (canImport)
      cols.push({
        id: "import",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.ip_address ? null : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={importOne.isPending}
              onClick={() => importOne.mutate(row.original)}
            >
              Add to IPAM
            </Button>
          ),
      })
    if (editable && (canChange || canDelete))
      cols.push({
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.managed ? (
            <div className="flex justify-end gap-1">
              {canChange && (
                <Button
                  size="xs"
                  variant="ghost"
                  title="Edit record"
                  onClick={() => setEditRec(row.original)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
              {canDelete && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  title="Delete record"
                  disabled={del.isPending}
                  onClick={() => del.mutate(row.original)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ) : null,
      })
    return cols
  }, [showZone, canImport, importOne, editable, canChange, canDelete, del])

  if (query.isError) return <QueryError error={query.error} />
  const table =
    rows.length === 0 && (providedRows !== undefined || query.data) ? (
      <EmptyState title={empty} />
    ) : (
      <DataTable
        data={rows}
        columns={columns}
        tableId={tableId}
        flexColumn="name"
      />
    )
  return (
    <>
      {table}
      <Dialog
        open={needPrefix !== null}
        onOpenChange={(o) => !o && setNeedPrefix(null)}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Create prefix</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            No prefix contains{" "}
            <span className="font-mono">{needPrefix?.rec.ip}</span>. Create one
            to import this record into IPAM.
          </p>
          <FormText
            label="Prefix (CIDR)"
            value={needPrefix?.cidr ?? ""}
            onChange={(v) => setNeedPrefix((n) => (n ? { ...n, cidr: v } : n))}
            mono
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNeedPrefix(null)}>
              Cancel
            </Button>
            <Button
              disabled={!needPrefix?.cidr.trim() || createPrefix.isPending}
              onClick={() =>
                needPrefix && createPrefix.mutate(needPrefix.cidr.trim())
              }
            >
              {createPrefix.isPending ? "Creating…" : "Create & import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DnsRecordDialog
        open={editRec !== null}
        onOpenChange={(o) => !o && setEditRec(null)}
        record={editRec}
      />
    </>
  )
}
