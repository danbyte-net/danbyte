import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import {
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type ComplianceEvaluation,
  type ComplianceRule,
  type ComplianceSeverity,
  type ComplianceViolation,
  type Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { Input } from "@/components/ui/input"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { FacetGroup, FilterRail } from "@/components/filter-rail"
import { useMe } from "@/lib/use-me"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

type Tab = "violations" | "rules"

/** URL-backed state of the Violations tab — filters live in the query string
 * so a filtered view is shareable and survives back/forward. Deep-linkable:
 * `/compliance?tab=violations&device=<id>&rule=<id>&severity=critical`. */
interface ComplianceSearch {
  tab: Tab
  /** Free-text search over object + rule name. */
  q?: string
  /** Comma-separated severities (critical,warning,info). */
  severity?: string
  /** Comma-separated object types (device,prefix,…). */
  type?: string
  /** A single rule id (or `config-drift`). */
  rule?: string
  /** A single object id (e.g. one device). */
  device?: string
}

const optStr = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined

function normalizeSearch(s: Record<string, unknown>): ComplianceSearch {
  return {
    tab: s.tab === "rules" ? "rules" : "violations",
    q: optStr(s.q),
    severity: optStr(s.severity),
    type: optStr(s.type),
    rule: optStr(s.rule),
    device: optStr(s.device),
  }
}

export const Route = createFileRoute("/compliance")({
  component: CompliancePage,
  validateSearch: normalizeSearch,
})

export const SEV_VARIANT: Record<
  ComplianceSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

export const OBJ_ROUTE: Record<string, string> = {
  prefix: "/prefixes/$id",
  ipaddress: "/ips/$id",
  device: "/devices/$id",
  vlan: "/vlans/$id",
  vrf: "/vrfs/$id",
  site: "/sites/$id",
}

const SEVERITIES: ComplianceSeverity[] = ["critical", "warning", "info"]

function CompliancePage() {
  const { tab } = Route.useSearch()
  const nav = useNavigate()
  // Preserve the violation filters in the URL when hopping between tabs.
  const go = (t: Tab) =>
    nav({
      to: "/compliance",
      search: (prev): ComplianceSearch => ({
        ...normalizeSearch(prev),
        tab: t,
      }),
    })

  const evalQ = useQuery({
    queryKey: ["compliance-eval"],
    queryFn: () => api<ComplianceEvaluation>("/api/compliance/evaluate/"),
    refetchOnWindowFocus: false,
  })
  const total = evalQ.data?.total_violations ?? 0

  return (
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Compliance
        </h1>
        <SegmentedTabs
          className="ml-2"
          value={tab}
          onValueChange={(v) => go(v as Tab)}
          items={[
            { value: "violations", label: "Violations" },
            { value: "rules", label: "Rules" },
          ]}
        />
        {tab === "violations" && total > 0 && (
          <Badge variant="destructive" className="ml-auto">
            {total} violation{total === 1 ? "" : "s"}
          </Badge>
        )}
      </header>

      {tab === "rules" ? (
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          <div className="mx-auto max-w-6xl">
            <RulesTab evaluation={evalQ.data} />
          </div>
        </div>
      ) : (
        <ViolationsTab q={evalQ} />
      )}
    </div>
  )
}

// ─── Violations ──────────────────────────────────────────────────────────────
function ViolationsTab({
  q,
}: {
  q: ReturnType<typeof useQuery<ComplianceEvaluation>>
}) {
  const data = q.data
  const urlSearch = Route.useSearch()
  const nav = useNavigate()

  // All filters are URL state (shareable + back/forward-safe). Facet sets are
  // encoded comma-separated; empty selections drop the param entirely.
  const patchSearch = (patch: Partial<ComplianceSearch>) =>
    nav({
      to: "/compliance",
      search: (prev): ComplianceSearch => {
        const cur = normalizeSearch(prev)
        return {
          tab: patch.tab ?? cur.tab,
          q: "q" in patch ? patch.q : cur.q,
          severity: "severity" in patch ? patch.severity : cur.severity,
          type: "type" in patch ? patch.type : cur.type,
          rule: "rule" in patch ? patch.rule : cur.rule,
          device: "device" in patch ? patch.device : cur.device,
        }
      },
      replace: true,
    })

  const typeFilter = useMemo(
    () => new Set((urlSearch.type ?? "").split(",").filter(Boolean)),
    [urlSearch.type]
  )
  const sevFilter = useMemo(
    () => new Set((urlSearch.severity ?? "").split(",").filter(Boolean)),
    [urlSearch.severity]
  )
  const toggleFacet = (
    key: "type" | "severity",
    set: Set<string>,
    v: string
  ) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    patchSearch({ [key]: next.size ? [...next].join(",") : undefined })
  }

  // Debounced free-text search → the `q` URL param. Back/forward restores the
  // box from the URL; typing never gets clobbered by a stale URL echo.
  const urlQ = urlSearch.q ?? ""
  const [search, setSearch] = useState(urlQ)
  const pushedQ = useRef(urlQ)
  useEffect(() => {
    if (urlQ !== pushedQ.current) {
      pushedQ.current = urlQ
      setSearch(urlQ)
    }
  }, [urlQ])
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== urlQ) {
        pushedQ.current = search
        patchSearch({ q: search || undefined })
      }
    }, 300)
    return () => clearTimeout(t)
    // Deliberately keyed on `search` alone: this is a one-way debounce.
  }, [search])

  const all = useMemo(() => data?.violations ?? [], [data])

  // Deep-link filters (`rule`, `device`) surface as dismissible chips; their
  // labels resolve from the evaluation itself.
  const ruleChip = urlSearch.rule
    ? (all.find((v) => v.rule_id === urlSearch.rule)?.rule_name ??
      urlSearch.rule)
    : null
  const deviceChip = urlSearch.device
    ? (all.find((v) => v.object_id === urlSearch.device)?.object_repr ??
      urlSearch.device)
    : null

  // Object-type facets with counts, from the live evaluation.
  const typeFacets = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>()
    for (const v of all) {
      const e = m.get(v.object_type)
      if (e) e.count++
      else m.set(v.object_type, { label: v.object_type_label, count: 1 })
    }
    return [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([value, { label, count }]) => ({ value, label, count }))
  }, [all])

  const sevFacets = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const v of all) counts[v.severity] = (counts[v.severity] ?? 0) + 1
    return SEVERITIES.filter((s) => counts[s]).map((s) => ({
      value: s,
      label: s[0].toUpperCase() + s.slice(1),
      count: counts[s],
    }))
  }, [all])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return all.filter((v) => {
      if (typeFilter.size > 0 && !typeFilter.has(v.object_type)) return false
      if (sevFilter.size > 0 && !sevFilter.has(v.severity)) return false
      if (urlSearch.rule && v.rule_id !== urlSearch.rule) return false
      if (urlSearch.device && v.object_id !== urlSearch.device) return false
      if (
        needle &&
        !v.object_repr.toLowerCase().includes(needle) &&
        !v.rule_name.toLowerCase().includes(needle)
      )
        return false
      return true
    })
  }, [all, search, typeFilter, sevFilter, urlSearch.rule, urlSearch.device])

  const columns = useMemo<ColumnDef<ComplianceViolation>[]>(
    () => [
      selectionColumn<ComplianceViolation>(),
      {
        id: "severity",
        accessorKey: "severity",
        header: ({ column }) => <SortHeader column={column} label="Severity" />,
        cell: ({ row }) => (
          <Badge
            variant={SEV_VARIANT[row.original.severity]}
            className="capitalize"
          >
            {row.original.severity}
          </Badge>
        ),
      },
      {
        id: "type",
        accessorKey: "object_type_label",
        header: ({ column }) => <SortHeader column={column} label="Type" />,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.object_type_label}
          </span>
        ),
      },
      {
        id: "object",
        accessorKey: "object_repr",
        header: ({ column }) => <SortHeader column={column} label="Object" />,
        cell: ({ row }) => {
          const route = OBJ_ROUTE[row.original.object_type]
          return route ? (
            <Link
              to={route}
              params={{ id: row.original.object_id }}
              className="font-mono font-medium hover:underline"
            >
              {row.original.object_repr}
            </Link>
          ) : (
            <span className="font-mono font-medium">
              {row.original.object_repr}
            </span>
          )
        },
      },
      {
        id: "rule",
        accessorKey: "rule_name",
        header: ({ column }) => <SortHeader column={column} label="Rule" />,
        cell: ({ row }) =>
          // Synthetic IaC drift "rule" isn't a real ComplianceRule — link it to
          // the Config-drift page instead of a (404) rule detail.
          row.original.rule_id === "config-drift" ? (
            <Link
              to="/config-drift"
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {row.original.rule_name}
            </Link>
          ) : (
            <Link
              to="/compliance-rules/$id"
              params={{ id: row.original.rule_id }}
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {row.original.rule_name}
            </Link>
          ),
      },
    ],
    []
  )

  return (
    <div className="flex min-h-0 flex-1">
      <FilterRail>
        <FacetGroup
          label="Object type"
          options={typeFacets}
          selected={typeFilter}
          onToggle={(v) => toggleFacet("type", typeFilter, v)}
        />
        <FacetGroup
          label="Severity"
          options={sevFacets}
          selected={sevFilter}
          onToggle={(v) => toggleFacet("severity", sevFilter, v)}
        />
      </FilterRail>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search object or rule…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-64 pl-8 text-xs"
            />
          </div>
          {ruleChip && (
            <FilterChip
              label="Rule"
              value={ruleChip}
              onClear={() => patchSearch({ rule: undefined })}
            />
          )}
          {deviceChip && (
            <FilterChip
              label="Object"
              value={deviceChip}
              onClear={() => patchSearch({ device: undefined })}
            />
          )}
          <span className="text-xs text-muted-foreground">
            {rows.length} of {all.length}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
            />
            Re-evaluate
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 lg:p-6">
          {q.isError && <QueryError error={q.error} />}

          {data && data.rules.length === 0 && (
            <EmptyState title="No enabled rules yet.">
              Add one in <span className="font-medium">Rules</span> to start
              checking.
            </EmptyState>
          )}

          {data && data.total_violations === 0 && data.rules.length > 0 && (
            <EmptyState title="All rules pass.">
              Nothing out of compliance right now.
            </EmptyState>
          )}

          {data && data.total_violations > 0 && (
            <DataTable
              data={rows}
              columns={columns}
              flexColumn="object"
              tableId="compliance-violations"
              exportName="compliance-violations"
              exportTitle="Compliance violations"
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** A dismissible pill for a deep-link filter (`rule` / `device` URL params). */
function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string
  value: string
  onClear: () => void
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted/40 pr-1 pl-2 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium">{value}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label.toLowerCase()} filter`}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

// ─── Rules ───────────────────────────────────────────────────────────────────
function RulesTab({ evaluation }: { evaluation?: ComplianceEvaluation }) {
  const { canDo } = useMe()
  const canAdd = canDo("compliancerule", "add")
  const canEdit = canDo("compliancerule", "change")
  const canDelete = canDo("compliancerule", "delete")
  const q = useQuery({
    queryKey: ["compliance-rules"],
    queryFn: () => api<Paginated<ComplianceRule>>("/api/compliance-rules/"),
  })
  const [deleting, setDeleting] = useState<ComplianceRule | null>(null)
  const rows = q.data?.results ?? []

  // rule id → live violation count (from the page-level evaluation).
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of evaluation?.rules ?? []) m.set(r.id, r.violations)
    return m
  }, [evaluation])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Policies asserted over your data. Empty = nothing is enforced.
        </p>
        {canAdd && (
          <Button size="sm" className="ml-auto" asChild>
            <Link to="/compliance-rules/new">
              <Plus className="h-3.5 w-3.5" /> New rule
            </Link>
          </Button>
        )}
      </div>

      {q.isError && <QueryError error={q.error} />}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-muted/40 text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Rule</th>
              <th className="px-3 py-2 font-medium">Applies to</th>
              <th className="px-3 py-2 font-medium">Check</th>
              <th className="px-3 py-2 font-medium">Severity</th>
              <th className="px-3 py-2 text-right font-medium">Violations</th>
              <th className="w-20 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => {
              const n = counts.get(r.id)
              return (
                <tr key={r.id} className="hover:bg-muted/40">
                  <td className="px-3 py-1.5">
                    <Link
                      to="/compliance-rules/$id"
                      params={{ id: r.id }}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    {!r.enabled && (
                      <Badge
                        variant="outline"
                        className="ml-2 h-4 px-1.5 text-[10px]"
                      >
                        off
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {r.object_type_label}
                  </td>
                  <td className="px-3 py-1.5 text-[12px] text-muted-foreground">
                    {ruleSummary(r)}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge
                      variant={SEV_VARIANT[r.severity]}
                      className="capitalize"
                    >
                      {r.severity}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {!r.enabled ? (
                      <span className="text-muted-foreground">—</span>
                    ) : n && n > 0 ? (
                      <Link
                        to="/compliance-rules/$id"
                        params={{ id: r.id }}
                        className="num font-medium text-destructive hover:underline"
                      >
                        {n}
                      </Link>
                    ) : (
                      <span className="num text-emerald-600 dark:text-emerald-400">
                        0
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          asChild
                        >
                          <Link
                            to="/compliance-rules/$id/edit"
                            params={{ id: r.id }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleting(r)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {q.data && rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  No compliance rules yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <DeleteRule
        rule={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

export function ruleSummary(
  r: Pick<ComplianceRule, "field" | "pattern" | "tag" | "cf_key"> & {
    check_type: string
    check_type_display?: string
  }
): string {
  switch (r.check_type) {
    case "required":
      return `${r.field} must be set`
    case "forbidden":
      return `${r.field} must be empty`
    case "regex":
      return `${r.field} ~ /${r.pattern}/`
    case "required_tag":
      return `must have tag “${r.tag}”`
    case "required_cf":
      return `cf “${r.cf_key}” must be set`
    default:
      return r.check_type_display ?? r.check_type
  }
}

export function DeleteRule({
  rule,
  onOpenChange,
  onDeleted,
}: {
  rule: ComplianceRule | null
  onOpenChange: (o: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api(`/api/compliance-rules/${rule!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rule!.name}`)
      qc.invalidateQueries({ queryKey: ["compliance-rules"] })
      qc.invalidateQueries({ queryKey: ["compliance-eval"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!rule} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {rule?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This rule will no longer be evaluated.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
