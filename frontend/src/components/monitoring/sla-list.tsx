import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated, SlaAgreement } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { slaAgreementColumns } from "@/components/columns/sla-columns"
import { HolidayCalendarsDialog } from "./holiday-calendars-dialog"
import { SlaCausesDialog } from "./sla-follow-up"
import { SlaOverviewSchedulesDialog } from "./sla-report-schedules"
import { SlaTemplatesDialog } from "./sla-templates"
import { useMonitoringCrumb } from "./monitoring-tabs"

/**
 * `/monitoring/sla` - every agreement with this period's figure against
 * its target, the budget left and how much of the time was measured.
 */
export function SlaList() {
  const crumb = useMonitoringCrumb()
  const { canDo } = useMe()
  const [q, setQ] = useState("")
  const [scheduling, setScheduling] = useState(false)
  // The catalogs agreements draw on, behind one Setup menu.
  const [catalog, setCatalog] = useState<
    "holidays" | "causes" | "templates" | null
  >(null)
  const catalogs = (
    [
      ["holidays", "Holiday calendars…", "holidaycalendar"],
      ["causes", "Incident causes…", "slaincidentcause"],
      ["templates", "SLA templates…", "slatemplate"],
    ] as const
  ).filter(([, , type]) => canDo(type, "view"))
  const close = (o: boolean) => !o && setCatalog(null)
  const query = useQuery({
    queryKey: ["sla-agreements", q],
    queryFn: () =>
      api<Paginated<SlaAgreement>>(
        `/api/monitoring/sla-agreements/?page_size=200${q ? `&q=${encodeURIComponent(q)}` : ""}`
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  })
  // The credit column only once some agreement is priced and visible to you.
  const credits = (query.data?.results ?? []).some(
    (a) => a.current?.figures.credit != null
  )
  const columns = useMemo(() => slaAgreementColumns({ credits }), [credits])
  return (
    <ListPageShell
      {...crumb}
      title="SLAs"
      count={query.data?.count}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Agreement or customer…",
      }}
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                Reports
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max">
              {(
                [
                  ["current", "This period"],
                  ["previous", "Last period"],
                ] as const
              ).map(([p, label]) =>
                (["pdf", "csv"] as const).map((f) => (
                  <DropdownMenuItem key={`${p}-${f}`} asChild>
                    <a
                      href={`/api/monitoring/sla-agreements/overview-report/?period=${p}${f === "csv" ? "&file=csv" : ""}`}
                      download
                    >
                      {label}, {f.toUpperCase()}
                    </a>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              {(["csv", "json"] as const).map((f) => (
                <DropdownMenuItem key={`metrics-${f}`} asChild>
                  <a
                    href={`/api/monitoring/sla-agreements/metrics/?file=${f}`}
                    download
                  >
                    Metrics, {f.toUpperCase()}
                  </a>
                </DropdownMenuItem>
              ))}
              {canDo("slaagreement", "change") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setScheduling(true)}>
                    Schedules…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <SlaOverviewSchedulesDialog
            open={scheduling}
            onOpenChange={setScheduling}
          />
          {catalogs.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  Setup
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-max">
                {catalogs.map(([key, label]) => (
                  <DropdownMenuItem key={key} onSelect={() => setCatalog(key)}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <HolidayCalendarsDialog
            open={catalog === "holidays"}
            onOpenChange={close}
          />
          <SlaCausesDialog open={catalog === "causes"} onOpenChange={close} />
          <SlaTemplatesDialog
            open={catalog === "templates"}
            onOpenChange={close}
          />
          {canDo("slaagreement", "add") && (
            <Button size="sm" asChild>
              <Link to="/monitoring/sla/new">Add agreement</Link>
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
