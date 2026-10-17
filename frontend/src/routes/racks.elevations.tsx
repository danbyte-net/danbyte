import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Device, Paginated, Rack } from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { batches } from "@/lib/batches"
import {
  RackElevation,
  type RackDisplayMode,
  type RackFace,
} from "@/components/rack-elevation"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { FormCheckbox } from "@/components/forms"

export const Route = createFileRoute("/racks/elevations")({
  component: RackElevationsPage,
  validateSearch: (
    s: Record<string, unknown>
  ): { site?: string; location?: string } => ({
    ...(typeof s.site === "string" ? { site: s.site } : {}),
    ...(typeof s.location === "string" ? { location: s.location } : {}),
  }),
})

/** Rack ids per device request: 100 UUIDs make a ~3.7 KB request line,
 * under the 4,094 bytes gunicorn accepts - one request for the wall's
 * page of 100 racks. */
const RACK_BATCH = 100

/** Elevations wall - every rack drawn side by side, so admins
 * see at a glance what lives where. Optionally scoped to one site via
 * ?site=<id> (the Sites / Locations pages link here). */
function RackElevationsPage() {
  const { site, location } = Route.useSearch()
  const [face, setFace] = useState<RackFace>("front")
  const [mode, setMode] = useState<RackDisplayMode>("names")
  const [labels, setLabels] = useState(true)

  const q = useQuery({
    queryKey: ["racks-elevations", site ?? "all", location ?? "all"],
    queryFn: () =>
      api<Paginated<Rack>>(
        `/api/racks/?page_size=100${site ? `&site=${site}` : ""}${
          location ? `&location=${location}` : ""
        }`
      ),
  })
  const racks = useMemo(() => q.data?.results ?? [], [q.data])
  const rackIds = useMemo(() => racks.map((r) => r.id), [racks])

  // Every rack's devices in one request, not one per rack (#431), seeded
  // into each rack's own cache entry so an elevation's edits still refresh
  // just its rack. Batched to keep the URL under proxy line limits.
  const qc = useQueryClient()
  const devicesQ = useQuery({
    queryKey: ["rack-devices-wall", rackIds],
    queryFn: async () => {
      const pages = await Promise.all(
        batches(rackIds, RACK_BATCH).map((part) =>
          api<Paginated<Device>>(`/api/devices/?rack=${part.join(",")}`)
        )
      )
      const byRack = new Map<string, Device[]>(rackIds.map((id) => [id, []]))
      for (const page of pages)
        for (const d of page.results) if (d.rack) byRack.get(d.rack.id)?.push(d)
      for (const [id, results] of byRack)
        qc.setQueryData<Paginated<Device>>(["rack-devices", id], {
          count: results.length,
          next: null,
          previous: null,
          results,
        })
      return rackIds.length
    },
    enabled: rackIds.length > 0,
  })
  const siteName = location
    ? racks[0]?.location?.name
    : site
      ? racks[0]?.site.name
      : null

  return (
    <ListPageShell
      backTo="/racks"
      backLabel="Racks"
      title={`Elevations${siteName ? ` · ${siteName}` : ""}`}
      count={q.data ? racks.length : undefined}
      actions={
        <>
          <SegmentedTabs<RackFace>
            value={face}
            onValueChange={setFace}
            items={[
              { value: "front", label: "Front" },
              { value: "rear", label: "Rear" },
            ]}
          />
          <SegmentedTabs<RackDisplayMode>
            value={mode}
            onValueChange={setMode}
            items={[
              { value: "names", label: "Names" },
              { value: "images", label: "Images" },
              { value: "render", label: "Render" },
            ]}
          />
          {mode !== "names" && (
            <FormCheckbox
              label="Text"
              checked={labels}
              onChange={setLabels}
              className="items-center gap-1 text-[11px] text-muted-foreground"
            />
          )}
        </>
      }
      query={q}
    >
      {racks.length === 0 ? (
        <EmptyState title={`No racks${siteName ? ` at ${siteName}` : ""} yet.`}>
          A rack gets an elevation as soon as it exists - add one from the Racks
          page.
        </EmptyState>
      ) : devicesQ.isError ? (
        <QueryError error={devicesQ.error} />
      ) : !devicesQ.isSuccess ? (
        <Loading />
      ) : (
        /* One column per rack, aligned at the top like a datacenter row. */
        <div className="flex items-start gap-8 overflow-x-auto pb-4">
          {racks.map((r) => (
            <div key={r.id} className="shrink-0">
              <div className="mb-2 flex items-baseline gap-2">
                <Link
                  to="/racks/$id"
                  params={{ id: r.id }}
                  className="link text-[13px] font-medium"
                >
                  {r.name}
                </Link>
                {!site && (
                  <span className="text-[11px] text-muted-foreground">
                    {r.site.name}
                  </span>
                )}
                <span className="num ml-auto text-[11px] text-muted-foreground">
                  {r.width}″ · {r.u_height}U
                </span>
              </div>
              <RackElevation
                rack={r}
                face={face}
                mode={mode}
                labels={labels}
                showHeader={false}
                prefetched
              />
            </div>
          ))}
        </div>
      )}
    </ListPageShell>
  )
}
