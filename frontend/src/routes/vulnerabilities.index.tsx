import { createFileRoute, Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { useMemo } from "react"

import type { VulnMatch, VulnRecordRow } from "@/lib/api"
import { useListSearch, useSearchWriter, useUrlSearch } from "@/lib/url-filters"
import { useServerList } from "@/lib/server-list"
import type { ServerFacetExtra } from "@/components/table-filters"
import { wireFacetColumns } from "@/components/table-filters"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { Loading } from "@/components/loading"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { buildVulnerabilityRecordColumns } from "@/components/columns/vulnerability-columns"
import { buildVulnerabilityMatchColumns } from "@/components/columns/vulnerability-match-columns"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

// Vulnerabilities (#451): every record matched in the tenant, one row each,
// or "By object" - one row per match (record × host × install). Both page,
// sort and facet on the server (vulnerabilities/list_api.py); the rail, the
// search box, the sort and the page live in the URL, so a link from the
// dashboard widget (`?priority=fix_first`, `?kev=yes`, `?first_seen=7d`)
// opens the filtered list.

export const Route = createFileRoute("/vulnerabilities/")({
  component: VulnerabilitiesPage,
})

type View = "records" | "objects"

const VIEWS = [
  { value: "records", label: "Records" },
  { value: "objects", label: "By object" },
] as const

/** Facets the server counts that no column carries. */
export const VULN_EXTRA_FACETS: ServerFacetExtra[] = [
  { id: "first_seen", label: "First seen", kind: "enum" },
  { id: "epss", label: "EPSS", kind: "range" },
  { id: "site", label: "Site", kind: "enum" },
  { id: "platform", label: "Platform", kind: "enum" },
  { id: "application", label: "Application", kind: "enum" },
]

export const RECORD_FACETS = ["priority", "severity", "kev"]
export const MATCH_FACETS = ["priority", "severity", "kev", "confidence", "via"]

function VulnerabilitiesPage() {
  const settings = useVulnSettings()
  const search = useListSearch()
  const write = useSearchWriter()
  const view: View = search.view === "objects" ? "objects" : "records"
  if (settings.isLoading) return <Loading />
  if (!settings.enabled) return <FeatureOff canManage={!!settings.data?.can_manage} />
  // The rail's facets mean the same in both views, so they stay; the page
  // and the sort start over.
  const viewSwitch = (
    <SegmentedTabs<View>
      value={view}
      onValueChange={(v) =>
        write((prev) => ({
          ...prev,
          view: v === "objects" ? v : undefined,
          page: undefined,
          ordering: undefined,
        }))
      }
      items={VIEWS}
    />
  )
  return view === "objects" ? (
    <MatchesView viewSwitch={viewSwitch} />
  ) : (
    <RecordsView viewSwitch={viewSwitch} />
  )
}

function FeatureOff({ canManage }: { canManage: boolean }) {
  return (
    <ListPageShell title="Vulnerabilities">
      <EmptyState title="Vulnerability data is off">
        {canManage ? (
          <>
            Turn it on in{" "}
            <Link to="/settings/admin" className="link">
              Settings → General → Vulnerability data
            </Link>
            .
          </>
        ) : (
          "A deployment admin turns it on."
        )}
      </EmptyState>
    </ListPageShell>
  )
}

function RecordsView({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [q, setQ] = useUrlSearch()
  const facetColumns = useMemo(() => buildVulnerabilityRecordColumns(), [])
  const list = useServerList<VulnRecordRow>({
    endpoint: "/api/vulnerabilities/",
    queryKey: "vulnerabilities",
    columns: facetColumns,
    facets: RECORD_FACETS,
    extraFacets: VULN_EXTRA_FACETS,
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo(
    () => wireFacetColumns(facetColumns, selectedValues, toggleValue),
    [facetColumns, selectedValues, toggleValue]
  )
  return (
    <ListPageShell
      title="Vulnerabilities"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      savedViews={{
        objectType: "vulnerability",
        filters: {
          snapshot: list.snapshot,
          restore: list.restore,
          activeCount: list.activeCount,
        },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter by id, summary…" }}
      actions={viewSwitch}
      query={list.query}
    >
      {list.total === 0 && list.activeCount === 0 && !q ? (
        <NothingMatched />
      ) : (
        <DataTable
          data={list.rows}
          columns={columns}
          {...list.tableProps}
          flexColumn="summary"
          tableId="vulnerabilities"
          exportName="vulnerabilities"
          exportTitle="Vulnerabilities"
        />
      )}
    </ListPageShell>
  )
}

function MatchesView({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [q, setQ] = useUrlSearch()
  const facetColumns = useMemo(() => buildVulnerabilityMatchColumns(), [])
  const list = useServerList<VulnMatch>({
    endpoint: "/api/vulnerabilities/matches/",
    queryKey: "vulnerability-matches",
    columns: facetColumns,
    facets: MATCH_FACETS,
    extraFacets: VULN_EXTRA_FACETS,
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo(
    () => wireFacetColumns(facetColumns, selectedValues, toggleValue),
    [facetColumns, selectedValues, toggleValue]
  )
  return (
    <ListPageShell
      title="Vulnerabilities"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      savedViews={{
        objectType: "vulnerabilitymatch",
        filters: {
          snapshot: list.snapshot,
          restore: list.restore,
          activeCount: list.activeCount,
        },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter by id, summary…" }}
      actions={viewSwitch}
      query={list.query}
    >
      {list.total === 0 && list.activeCount === 0 && !q ? (
        <NothingMatched />
      ) : (
        <DataTable
          data={list.rows}
          columns={columns}
          {...list.tableProps}
          flexColumn="summary"
          tableId="vulnerability-matches"
          exportName="vulnerability-matches"
          exportTitle="Vulnerabilities by object"
        />
      )}
    </ListPageShell>
  )
}

function NothingMatched() {
  return (
    <EmptyState title="No known vulnerabilities">
      Nothing you can see matches the vulnerability data.
    </EmptyState>
  )
}
