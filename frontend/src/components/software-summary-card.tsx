import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { InstalledSoftware, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Section } from "@/components/ui/section"
import { OverviewTable } from "@/components/overview-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { LifetimeBar } from "@/components/cells/lifecycle-cell"
import { useEolSettings } from "@/components/cells/eol-cell"

// The Overview's "Software" card on device and VM pages (#436): the first
// installs as the Software tab lists them, each with its time to end of life,
// then a link to the tab for the rest.

export const SOFTWARE_SUMMARY_ROWS = 8

export type SoftwareSummaryParent = { kind: "device" | "vm"; id: string }

/** The first page of the parent's installs, sized to the card. Its key sits
 * under the Software tab's, so the tab's add/edit/delete refresh it. */
export function useSoftwareSummary(parent: SoftwareSummaryParent) {
  const { canDo } = useMe()
  const param =
    parent.kind === "device"
      ? `device=${parent.id}`
      : `virtual_machine=${parent.id}`
  return useQuery({
    queryKey: ["installed-software", parent.kind, parent.id, "summary"],
    queryFn: () =>
      api<Paginated<InstalledSoftware>>(
        `/api/installed-software/?${param}&page_size=${SOFTWARE_SUMMARY_ROWS}`
      ),
    enabled: canDo("installedsoftware", "view"),
  })
}

export function SoftwareSummaryCard({
  parent,
}: {
  parent: SoftwareSummaryParent
}) {
  const { canDo } = useMe()
  const q = useSoftwareSummary(parent)
  const eol = useEolSettings()
  if (!canDo("installedsoftware", "view")) return null

  const rows = q.data?.results ?? []
  const count = q.data?.count
  const columns: SimpleColumn<InstalledSoftware>[] = [
    {
      id: "application",
      header: "Application",
      cell: (r) => (
        <span className="inline-flex min-w-0 items-baseline gap-2">
          <Link
            to="/applications/$id"
            params={{ id: r.application.id }}
            className="link truncate font-medium"
          >
            {r.application.name}
          </Link>
          {r.version && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {r.version}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "lifetime",
      header: "End of life",
      cell: (r) => (
        <LifetimeBar
          start={r.effective_release}
          end={r.effective_end}
          warningDays={eol.data?.warning_days}
          source={r.effective_source}
        />
      ),
    },
  ]

  const tabLink =
    parent.kind === "device" ? (
      <Link
        to="/devices/$id"
        params={{ id: parent.id }}
        search={{ tab: "software" }}
        className="link"
      >
        View all {count}
      </Link>
    ) : (
      <Link
        to="/virtual-machines/$id"
        params={{ id: parent.id }}
        search={{ tab: "software" }}
        className="link"
      >
        View all {count}
      </Link>
    )

  if (rows.length > 0)
    return (
      <OverviewTable
        title="Software"
        count={count}
        columns={columns}
        data={rows}
        getRowKey={(r) => r.id}
        footer={count != null && count > rows.length ? tabLink : undefined}
      />
    )
  return (
    <Section title="Software">
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : (
        <p className="text-sm text-muted-foreground">No software recorded.</p>
      )}
    </Section>
  )
}
