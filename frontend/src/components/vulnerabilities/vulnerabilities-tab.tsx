import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ShieldOff } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated, VulnMatch } from "@/lib/api"
import { useUrlSet } from "@/lib/url-filters"
import { DataTable, selectionColumn } from "@/components/data-table"
import { Button } from "@/components/ui/button"
import { actionsColumn } from "@/components/columns/actions-column"
import {
  ExceptionDialog,
  useExceptionPerms,
} from "@/components/vulnerabilities/exception-dialog"
import { EmptyState } from "@/components/empty-state"
import { FacetGroup } from "@/components/filter-rail"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildVulnerabilityMatchColumns } from "@/components/columns/vulnerability-match-columns"
import type { VulnMatchColumnId } from "@/components/columns/vulnerability-match-columns"

// The Vulnerabilities tab on a device, VM, platform or application (#451):
// the object's matches with priority, severity, KEV, EPSS and confidence -
// and, with `kind="record"`, a record page's Affected tab (every host and
// install it matched, resolved history one tick away).
// Filters live in the URL (`?vstatus=`, `?priority=`, `?severity=`, `?kev=`,
// `?confidence=`). The page shows the tab only while the feature is on.

export type VulnSubject =
  "device" | "virtual_machine" | "platform" | "application" | "record"

const PATH: Record<Exclude<VulnSubject, "record">, string> = {
  device: "devices",
  virtual_machine: "virtual-machines",
  platform: "platforms",
  application: "applications",
}

/** Every match row of the object, open and resolved. */
export function matchesUrl(kind: VulnSubject, id: string): string {
  if (kind === "record")
    return `/api/vulnerabilities/matches/?cve=${encodeURIComponent(id)}&status=all&excepted=all&page_size=1000`
  return `/api/${PATH[kind]}/${id}/vulnerabilities/?status=all&excepted=all&page_size=500`
}

const OMIT: Record<VulnSubject, VulnMatchColumnId[]> = {
  device: ["host"],
  virtual_machine: ["host"],
  platform: ["application", "via"],
  application: ["via"],
  // One record: its own facts are the page's Overview.
  record: ["record", "priority", "severity", "score", "kev", "epss", "summary"],
}

const TABLE_ID: Record<VulnSubject, string> = {
  device: "device-vulnerabilities",
  virtual_machine: "vm-vulnerabilities",
  platform: "platform-vulnerabilities",
  application: "application-vulnerabilities",
  record: "vulnerability-affected",
}

/** The search params the tab writes, for a route's `validateSearch`. */
export const VULN_TAB_PARAMS = [
  "vstatus",
  "priority",
  "severity",
  "kev",
  "confidence",
  "via",
  "excepted",
  // One inventoried package's matches (the Packages tab's CVEs badge).
  "vpackage",
] as const

/** Keep the tab's filter params through a route's `validateSearch`. */
export function vulnTabSearch(
  s: Record<string, unknown>
): Partial<Record<(typeof VULN_TAB_PARAMS)[number], string>> {
  const out: Partial<Record<(typeof VULN_TAB_PARAMS)[number], string>> = {}
  for (const k of VULN_TAB_PARAMS) {
    const v = s[k]
    if (typeof v === "string" && v) out[k] = v
  }
  return out
}

const STATUS_LABELS = { open: "Open", resolved: "Resolved" } as const
type MatchStatus = keyof typeof STATUS_LABELS

/** Nothing ticked reads as Open: history is one tick away. */
export function effectiveStatus(param: Set<string>): Set<MatchStatus> {
  const s = new Set(
    [...param].filter((v): v is MatchStatus => v === "open" || v === "resolved")
  )
  return s.size ? s : new Set<MatchStatus>(["open"])
}

export function VulnerabilitiesTab({
  kind,
  id,
}: {
  kind: VulnSubject
  id: string
}) {
  const q = useQuery({
    queryKey: ["vulnerabilities", kind, id],
    queryFn: () => api<Paginated<VulnMatch>>(matchesUrl(kind, id)),
  })
  const [statusParam, setStatusParam] = useUrlSet("vstatus")
  const status = useMemo(() => effectiveStatus(statusParam), [statusParam])
  const [pkgParam, setPkgParam] = useUrlSet("vpackage")
  const all = q.data?.results
  const rows = useMemo(
    () =>
      (all ?? []).filter(
        (r) =>
          status.has(r.resolved_at ? "resolved" : "open") &&
          (pkgParam.size === 0 ||
            (!!r.host_package && pkgParam.has(r.host_package.id)))
      ),
    [all, status, pkgParam]
  )
  const { canAdd } = useExceptionPerms()
  const [selected, setSelected] = useState<VulnMatch[]>([])
  const [excepting, setExcepting] = useState<VulnMatch[] | null>(null)
  const columns = useMemo(
    () => [
      ...(canAdd ? [selectionColumn<VulnMatch>()] : []),
      ...buildVulnerabilityMatchColumns({
        omit: OMIT[kind],
        showResolved: status.has("resolved"),
      }),
      ...(canAdd
        ? [
            actionsColumn<VulnMatch>({
              extra: (r) =>
                r.resolved_at ? null : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    title="Add exception"
                    onClick={() => setExcepting([r])}
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
                    <span className="sr-only">Add exception</span>
                  </Button>
                ),
            }),
          ]
        : []),
    ],
    [kind, status, canAdd]
  )
  const openSelected = selected.filter((r) => !r.resolved_at)
  const counts = useMemo(() => {
    const c = { open: 0, resolved: 0 }
    for (const r of all ?? []) c[r.resolved_at ? "resolved" : "open"]++
    return c
  }, [all])

  // The package narrowing, while one is in the URL: untick to see all.
  const packageNames = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>()
    for (const r of all ?? []) {
      const p = r.host_package
      if (!p || !pkgParam.has(p.id)) continue
      const have = m.get(p.id) ?? { name: p.name, count: 0 }
      have.count++
      m.set(p.id, have)
    }
    return m
  }, [all, pkgParam])
  const packageFacet =
    pkgParam.size > 0 ? (
      <FacetGroup
        label="Package"
        facetId="vpackage"
        options={[...pkgParam].map((v) => ({
          value: v,
          label: packageNames.get(v)?.name ?? "Package",
          count: packageNames.get(v)?.count ?? 0,
        }))}
        selected={pkgParam}
        onToggle={(v) => {
          const next = new Set<string>(pkgParam)
          next.delete(v)
          setPkgParam(next)
        }}
      />
    ) : null
  const statusFacet = (
    <FacetGroup
      label="Status"
      facetId="vstatus"
      options={(Object.keys(STATUS_LABELS) as MatchStatus[]).map((v) => ({
        value: v,
        label: STATUS_LABELS[v],
        count: counts[v],
      }))}
      selected={status}
      onToggle={(v) => {
        const next = new Set<string>(status)
        if (next.has(v)) next.delete(v)
        else next.add(v)
        // Open alone is the default: keep it out of the URL.
        setStatusParam(next.size === 1 && next.has("open") ? new Set() : next)
      }}
    />
  )
  const {
    rail,
    columns: wired,
    filteredRows,
  } = useUrlTableFilters(columns, rows, {
    railExtras: (
      <>
        {statusFacet}
        {packageFacet}
      </>
    ),
  })

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if ((all ?? []).length === 0)
    return kind === "record" ? (
      <EmptyState title="Nothing affected">
        Nothing you can see in this tenant runs an affected version.
      </EmptyState>
    ) : (
      <EmptyState title="No known vulnerabilities">
        Nothing in the vulnerability data matches{" "}
        {kind === "platform" || kind === "application"
          ? "its mapped products"
          : "its software"}
        .
      </EmptyState>
    )

  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {canAdd && openSelected.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {openSelected.length} selected
            </span>
            <Button size="sm" onClick={() => setExcepting(openSelected)}>
              Add exception
            </Button>
          </div>
        )}
        <DataTable
          onSelectedRowsChange={setSelected}
          selectedRows={selected}
          tableId={TABLE_ID[kind]}
          data={filteredRows}
          columns={wired}
          flexColumn={kind === "record" ? "host" : "summary"}
          searchable
          searchPlaceholder={
            kind === "record" ? "Search hosts…" : "Search records…"
          }
          exportName={TABLE_ID[kind]}
          autoColumns={false}
        />
      </div>
      <ExceptionDialog
        open={!!excepting}
        onOpenChange={(o) => !o && setExcepting(null)}
        matches={excepting ?? []}
        kind={kind}
      />
    </div>
  )
}
