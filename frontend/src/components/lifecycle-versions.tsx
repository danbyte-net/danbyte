import { useMemo } from "react"
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SoftwareVersionFacet, SoftwareVersionSummary } from "@/lib/api"
import { encodeList, useUrlSearch, useUrlSet } from "@/lib/url-filters"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { FacetGroup, FilterRail } from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { buildSoftwareVersionColumns } from "@/components/columns/software-version-columns"
import type { VersionLinkScope } from "@/components/columns/software-version-columns"

// Lifecycle → Versions (#451): how many devices and VMs run each version,
// per platform. The site, platform and role filters go to the server (the
// rows are counts, not objects); each count links to the device or VM list
// narrowed the same way. /lifecycle?view=versions&site=<id>

type Row = SoftwareVersionSummary["results"][number] & { id: string }

/** The server's `none` is the lists' `__none__`. */
const toListValue = (v: string) => (v === "none" ? "__none__" : v)

function facetOptions(
  facets: SoftwareVersionFacet[] | undefined,
  none: string
) {
  return (facets ?? []).map((f) => ({
    value: f.id ?? "none",
    label: f.id ? f.name : none,
    count: f.count,
    color: f.color || undefined,
  }))
}

export function LifecycleVersions({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [search, setSearch] = useUrlSearch()
  const [sites, setSites] = useUrlSet("site")
  const [platforms, setPlatforms] = useUrlSet("platform")
  const [roles, setRoles] = useUrlSet("role")

  const params = new URLSearchParams()
  for (const [key, set] of [
    ["site", sites],
    ["platform", platforms],
    ["role", roles],
  ] as const) {
    if (set.size) params.set(key, [...set].join(","))
  }
  const qs = params.toString()
  const q = useQuery({
    queryKey: ["lifecycle-versions", qs],
    queryFn: () =>
      api<SoftwareVersionSummary>(
        qs ? `/api/lifecycle/versions/?${qs}` : "/api/lifecycle/versions/"
      ),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })

  const rows = useMemo<Row[]>(
    () =>
      (q.data?.results ?? []).map((r) => ({
        ...r,
        id: `${r.platform?.id ?? "-"}:${r.version}`,
      })),
    [q.data]
  )
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(
      (r) =>
        r.version.toLowerCase().includes(s) ||
        (r.platform?.name ?? "").toLowerCase().includes(s)
    )
  }, [rows, search])

  const scopeSite = encodeList([...sites].map(toListValue))
  const scopeRole = encodeList([...roles].map(toListValue))
  const columns = useMemo(() => {
    const scope: VersionLinkScope = { site: scopeSite, role: scopeRole }
    return buildSoftwareVersionColumns<Row>({ scope })
  }, [scopeSite, scopeRole])

  const toggle =
    (set: (fn: (prev: Set<string>) => Set<string>) => void) => (v: string) =>
      set((prev) => {
        const next = new Set(prev)
        if (next.has(v)) next.delete(v)
        else next.add(v)
        return next
      })

  const facets = q.data?.facets
  const rail = (
    <FilterRail>
      <FacetGroup
        label="Site"
        facetId="versions-site"
        options={facetOptions(facets?.site, "No site")}
        selected={sites}
        onToggle={toggle(setSites)}
      />
      <FacetGroup
        label="Platform"
        facetId="versions-platform"
        options={facetOptions(facets?.platform, "No platform")}
        selected={platforms}
        onToggle={toggle(setPlatforms)}
      />
      <FacetGroup
        label="Role"
        facetId="versions-role"
        options={facetOptions(facets?.role, "No role")}
        selected={roles}
        onToggle={toggle(setRoles)}
      />
    </FilterRail>
  )

  return (
    <ListPageShell
      title="Lifecycle"
      count={q.data ? shown.length : undefined}
      rail={rail}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter versions…",
      }}
      actions={viewSwitch}
      query={q}
    >
      {rows.length === 0 ? (
        <EmptyState title="No devices or VMs.">
          Versions come from{" "}
          <Link to="/devices" className="link">
            devices
          </Link>{" "}
          and{" "}
          <Link to="/virtual-machines" className="link">
            virtual machines
          </Link>
          .
        </EmptyState>
      ) : (
        <DataTable
          data={shown}
          columns={columns}
          flexColumn="version"
          tableId="lifecycle-versions"
          exportName="software-versions"
          exportTitle="Software versions"
        />
      )}
    </ListPageShell>
  )
}
