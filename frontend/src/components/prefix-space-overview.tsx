import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api, type Prefix, type Paginated } from "@/lib/api"
import { UtilCell } from "@/components/cells/util-cell"
import { VrfCell } from "@/components/cells/vrf-cell"
import { parseCidr } from "@/lib/prefix-tree"
import { QueryError } from "@/components/query-error"

// Tenant-wide space map: every prefix, grouped by VRF and sorted by network, as
// a utilisation list you can scan top-to-bottom. Click a row to drill into that
// prefix's detailed per-block space map. Reads the same prefix list the table
// uses (utilisation is already computed server-side), so it's purely a view.

type Group = { vrf: Prefix["vrf"]; rows: Prefix[]; avg: number | null }

function group(prefixes: Prefix[]): Group[] {
  const byVrf = new Map<string, Prefix[]>()
  for (const p of prefixes) {
    const key = p.vrf?.id ?? "__global__"
    const arr = byVrf.get(key)
    if (arr) arr.push(p)
    else byVrf.set(key, [p])
  }
  const groups: Group[] = []
  for (const rows of byVrf.values()) {
    rows.sort((a, b) => {
      const ca = parseCidr(a.cidr)
      const cb = parseCidr(b.cidr)
      if (!ca || !cb) return a.cidr.localeCompare(b.cidr)
      if (ca.start !== cb.start) return ca.start < cb.start ? -1 : 1
      return ca.prefixlen - cb.prefixlen
    })
    const measured = rows.filter((p) => p.utilisation_pct !== null)
    const avg = measured.length
      ? Math.round(
          measured.reduce((s, p) => s + (p.utilisation_pct ?? 0), 0) /
            measured.length
        )
      : null
    groups.push({ vrf: rows[0].vrf, rows, avg })
  }
  // Global VRF first, then by VRF name.
  groups.sort((a, b) => {
    if (!a.vrf) return -1
    if (!b.vrf) return 1
    return a.vrf.name.localeCompare(b.vrf.name)
  })
  return groups
}

export function PrefixSpaceOverview() {
  const q = useQuery({
    queryKey: ["prefixes", "space-overview"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/?page_size=1000"),
    staleTime: 60_000,
  })
  const groups = useMemo(() => group(q.data?.results ?? []), [q.data])

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  if (groups.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No prefixes yet. Add one to see the space map.
      </p>
    )

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section
          key={g.vrf?.id ?? "global"}
          className="rounded-lg border border-border"
        >
          <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <VrfCell vrf={g.vrf} linked={false} />
            <span className="text-[11px] text-muted-foreground">
              {g.rows.length} prefix{g.rows.length === 1 ? "" : "es"}
              {g.avg !== null && ` · ${g.avg}% avg fill`}
            </span>
          </header>
          <ul className="divide-y divide-border">
            {g.rows.map((p) => (
              <li key={p.id}>
                <Link
                  to="/prefixes/$id"
                  params={{ id: p.id }}
                  className="flex items-center gap-3 px-4 py-1.5 text-[13px] hover:bg-muted/50"
                >
                  <span className="w-44 shrink-0 font-mono">{p.cidr}</span>
                  {p.status?.name === "container" ? (
                    <span className="flex-1 text-[11px] text-muted-foreground">
                      container · {p.child_count} child
                      {p.child_count === 1 ? "" : "ren"}
                    </span>
                  ) : (
                    <span className="flex-1">
                      <UtilCell pct={p.utilisation_pct} />
                    </span>
                  )}
                  <span className="num w-16 text-right text-[11px] text-muted-foreground">
                    {p.ip_count} IP{p.ip_count === 1 ? "" : "s"}
                  </span>
                  <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">
                    {p.site?.name ?? ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
