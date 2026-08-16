import { useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type DnsRecord, type Paginated } from "@/lib/api"
import { ListPageShell } from "@/components/list-page-shell"
import { DnsRecordsTable } from "@/components/integrations/dns-records-table"
import { useFacetRail } from "@/lib/use-facet-rail"

export const Route = createFileRoute("/dns-records/")({
  component: DnsRecordsPage,
})

function DnsRecordsPage() {
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["dns-records", "all", q],
    queryFn: () =>
      api<Paginated<DnsRecord>>(
        `/api/dns-records/?search=${encodeURIComponent(q)}&page_size=500`
      ),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])

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
      <DnsRecordsTable
        rows={filtered}
        showZone
        empty={q ? "No records match." : "No DNS records stored."}
        tableId="dns-records-all"
      />
    </ListPageShell>
  )
}
