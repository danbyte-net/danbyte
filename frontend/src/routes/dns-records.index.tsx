import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type DnsRecord, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ListPageShell } from "@/components/list-page-shell"
import { DnsRecordsTable } from "@/components/integrations/dns-records-table"
import { useFacetRail } from "@/lib/use-facet-rail"

export const Route = createFileRoute("/dns-records/")({
  validateSearch: (s: Record<string, unknown>) => ({
    zone: typeof s.zone === "string" ? s.zone : undefined,
  }),
  component: DnsRecordsPage,
})

function DnsRecordsPage() {
  const { zone } = Route.useSearch()
  const [q, setQ] = useState("")
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

  return (
    <ListPageShell
      title="DNS records"
      count={query.data ? filtered.length : undefined}
      query={query}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Name or address…" }}
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
      />
    </ListPageShell>
  )
}
