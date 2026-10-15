import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  CoverageStatus,
  Paginated,
  SupportCoverageSummary,
} from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  COVERAGE_LABELS,
  ContractStateBadge,
} from "@/components/cells/coverage-cell"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

// Dashboard widget "Support coverage" (#421): devices per coverage status -
// each count opens the device list on that status - and the contracts that
// end soonest. Narrowed by site and manufacturer, chosen while editing.

export interface SupportCoverageConfig {
  site?: { id: string; name: string } | null
  manufacturer?: { id: string; name: string } | null
}

const ORDER: CoverageStatus[] = ["expired", "expiring", "none", "covered"]

const TONE: Record<CoverageStatus, string> = {
  expired: "text-red-600 dark:text-red-400",
  expiring: "text-amber-600 dark:text-amber-400",
  none: "text-foreground",
  covered: "text-emerald-600 dark:text-emerald-400",
}

const ALL = "__all__"

type Named = { id: string; name: string }

function useNamed(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ["support-coverage-widget-options", path],
    queryFn: () => api<Paginated<Named>>(`${path}?page_size=500`),
    enabled,
    staleTime: 5 * 60_000,
  })
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Named | null | undefined
  options: Named[]
  onChange: (v: Named | null) => void
}) {
  return (
    <Select
      value={value?.id ?? ALL}
      onValueChange={(v) =>
        onChange(v === ALL ? null : (options.find((o) => o.id === v) ?? null))
      }
    >
      <SelectTrigger size="sm" aria-label={label} className="min-w-0 flex-1">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{`Any ${label.toLowerCase()}`}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SupportCoverageWidget({
  config,
  editing,
  setConfig,
}: {
  config?: SupportCoverageConfig
  editing?: boolean
  setConfig?: (c: SupportCoverageConfig) => void
}) {
  const site = config?.site ?? null
  const manufacturer = config?.manufacturer ?? null
  const params = new URLSearchParams()
  if (site) params.set("site", site.id)
  if (manufacturer) params.set("manufacturer", manufacturer.id)
  const q = useQuery({
    queryKey: ["support-coverage-summary", site?.id, manufacturer?.id],
    queryFn: () =>
      api<SupportCoverageSummary>(
        `/api/devices/coverage-summary/?${params.toString()}`
      ),
    staleTime: 60_000,
  })
  const sites = useNamed("/api/sites/", !!editing)
  const mfrs = useNamed("/api/manufacturers/", !!editing)
  const { formatDate } = useDateFormat()

  const save = (patch: SupportCoverageConfig) =>
    setConfig?.({ site, manufacturer, ...patch })

  // The device list facets bucket sites by id and manufacturers by name.
  const search = (status: CoverageStatus) => ({
    coverage: status,
    ...(site ? { site: site.id } : {}),
    ...(manufacturer ? { manufacturer: manufacturer.name } : {}),
  })

  return (
    <div className="flex h-full flex-col gap-3">
      {editing && (
        <div className="flex gap-2">
          <FilterSelect
            label="Site"
            value={site}
            options={sites.data?.results ?? []}
            onChange={(v) => save({ site: v })}
          />
          <FilterSelect
            label="Manufacturer"
            value={manufacturer}
            options={mfrs.data?.results ?? []}
            onChange={(v) => save({ manufacturer: v })}
          />
        </div>
      )}
      {q.isLoading ? (
        <Loading className="min-h-[80px]" />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : q.data ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {ORDER.map((s) => {
              const n = q.data.counts[s]
              return (
                <Link
                  key={s}
                  to="/devices"
                  search={search(s)}
                  className="flex flex-col justify-center rounded-md border border-border p-2 hover:bg-muted/40"
                >
                  <span
                    className={`text-xl font-semibold tabular-nums ${
                      n > 0 ? TONE[s] : "text-muted-foreground"
                    }`}
                  >
                    {n.toLocaleString()}
                  </span>
                  <span className="mt-0.5 text-[11px] whitespace-nowrap text-muted-foreground">
                    {COVERAGE_LABELS[s]}
                  </span>
                </Link>
              )
            })}
          </div>
          {(site || manufacturer) && (
            <p className="text-[11px] text-muted-foreground">
              {[site?.name, manufacturer?.name].filter(Boolean).join(" · ")}
            </p>
          )}
          {q.data.ending.length > 0 && (
            <div className="min-h-0 flex-1 overflow-auto">
              <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-foreground uppercase">
                Ending soonest
              </h3>
              <ul className="divide-y divide-border text-[13px]">
                {q.data.ending.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2 py-1.5"
                  >
                    <span className="min-w-0 truncate">
                      <Link
                        to="/support-contracts/$id"
                        params={{ id: c.id }}
                        className="link font-mono text-xs"
                      >
                        {c.contract_number}
                      </Link>{" "}
                      <span className="text-muted-foreground">
                        {c.manufacturer.name}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="num text-xs whitespace-nowrap text-muted-foreground">
                        {formatDate(c.end_date)}
                      </span>
                      <ContractStateBadge state={c.state} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
