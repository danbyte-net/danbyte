import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { api, type Paginated, type Rack } from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
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
  const racks = q.data?.results ?? []
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
              />
            </div>
          ))}
        </div>
      )}
    </ListPageShell>
  )
}
