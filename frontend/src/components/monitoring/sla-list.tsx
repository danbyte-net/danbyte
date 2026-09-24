import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated, SlaAgreement } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { slaAgreementColumns } from "@/components/columns/sla-columns"
import { HolidayCalendarsButton } from "./holiday-calendars-dialog"

/**
 * `/monitoring?view=sla` - every agreement with this period's figure against
 * its target, the budget left and how much of the time was measured.
 */
export function SlaList() {
  const { canDo } = useMe()
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["sla-agreements", q],
    queryFn: () =>
      api<Paginated<SlaAgreement>>(
        `/api/monitoring/sla-agreements/?page_size=200${q ? `&q=${encodeURIComponent(q)}` : ""}`
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  })
  const columns = useMemo(() => slaAgreementColumns(), [])
  return (
    <ListPageShell
      title="SLAs"
      count={query.data?.count}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Agreement or customer…",
      }}
      actions={
        <>
          <HolidayCalendarsButton />
          {canDo("slaagreement", "add") && (
            <Button size="sm" asChild>
              <Link to="/monitoring/sla/new">
                <Plus className="h-3.5 w-3.5" /> New agreement
              </Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        columns={columns}
        data={query.data?.results ?? []}
        tableId="sla-agreements"
        exportName="sla-agreements"
        exportTitle="SLA agreements"
        flexColumn="name"
      />
    </ListPageShell>
  )
}
