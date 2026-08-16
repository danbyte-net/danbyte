import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { ListPageShell } from "@/components/list-page-shell"
import { DnsRecordsTable } from "@/components/integrations/dns-records-table"

export const Route = createFileRoute("/dns-records/")({
  component: DnsRecordsPage,
})

function DnsRecordsPage() {
  const [q, setQ] = useState("")
  return (
    <ListPageShell
      title="DNS records"
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Name or address…",
      }}
    >
      <DnsRecordsTable
        params={`search=${encodeURIComponent(q)}`}
        queryKey={["dns-records", "all", q]}
        showZone
        empty={
          q
            ? "No records match."
            : "No DNS records stored — turn on reconcile for a zone."
        }
        tableId="dns-records-all"
      />
    </ListPageShell>
  )
}
