import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { api, type DnsRecord, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import {
  DnsRecordsTable,
  useDnsBulkImport,
} from "@/components/integrations/dns-records-table"
import { DnsRecordDialog } from "@/components/integrations/dns-record-dialog"
import { useFacetRail } from "@/lib/use-facet-rail"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/dns-records/")({
  validateSearch: (s: Record<string, unknown>) => ({
    zone: typeof s.zone === "string" ? s.zone : undefined,
  }),
  component: DnsRecordsPage,
})

function DnsRecordsPage() {
  const { zone } = Route.useSearch()
  const { canDo } = useMe()
  const canAdd = canDo("dnsrecord", "add")
  const canImport = canDo("ipaddress", "add")
  const [adding, setAdding] = useState(false)
  const [addingAll, setAddingAll] = useState(false)
  const addAll = useDnsBulkImport(() => setAddingAll(false))
  const [q, setQ] = useUrlSearch()
  const query = useQuery({
    queryKey: ["dns-records", "all", q, zone ?? ""],
    queryFn: () => {
      const p = new URLSearchParams({ search: q })
      if (zone) p.set("zone", zone)
      return api<Paginated<DnsRecord>>(`/api/dns-records/?${p}&page_size=500`)
    },
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const zoneLabel = zone ? rows[0]?.zone_name : undefined

  const { rail, filtered } = useFacetRail(rows, [
    {
      key: "server",
      label: "Server",
      get: (r) => ({ value: r.connection_name, label: r.connection_name }),
    },
    {
      key: "type",
      label: "Type",
      get: (r) => ({ value: r.record_type, label: r.record_type }),
    },
    {
      key: "ipam",
      label: "In IPAM",
      get: (r) => ({
        value: r.ip_address ? "yes" : "no",
        label: r.ip_address ? "In IPAM" : "Not in IPAM",
      }),
    },
  ])

  // What Add all takes: the records the filters show that IPAM lacks.
  const pending = filtered.filter((r) => !r.ip_address)

  return (
    <ListPageShell
      title="DNS records"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Name or address…" }}
      actions={
        <>
          {canImport && pending.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddingAll(true)}
            >
              Add all to IPAM
            </Button>
          )}
          {canAdd && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add record
            </Button>
          )}
        </>
      }
    >
      {zone && (
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">Zone {zoneLabel || zone}</Badge>
          <Button variant="ghost" size="sm" className="h-6 px-2" asChild>
            <Link to="/dns-records" search={{ zone: undefined }}>
              Clear
            </Link>
          </Button>
        </div>
      )}
      <DnsRecordsTable
        rows={filtered}
        showZone={!zone}
        empty={q ? "No records match." : "No DNS records stored."}
        tableId="dns-records-all"
        editable
        bulkImport
      />
      <ConfirmDialog
        open={addingAll}
        onOpenChange={setAddingAll}
        title="Add all to IPAM"
        description={`Add the ${pending.length === 1 ? "1 record" : `${pending.length} records`} shown that IPAM doesn't have yet. Records no prefix holds are skipped.`}
        confirmLabel="Add all"
        pendingLabel="Adding…"
        destructive={false}
        pending={addAll.isPending}
        onConfirm={() => addAll.mutate(pending.map((r) => r.id))}
      />
      <DnsRecordDialog open={adding} onOpenChange={setAdding} zoneId={zone} />
    </ListPageShell>
  )
}
