import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useState } from "react"

import { api, type Paginated, type Rack } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import {
  RackElevation,
  type RackDisplayMode,
  type RackFace,
} from "@/components/rack-elevation"
import { SegmentedTabs } from "@/components/segmented-tabs"

export const Route = createFileRoute("/racks/elevations")({
  component: RackElevationsPage,
  validateSearch: (
    s: Record<string, unknown>
  ): { site?: string; location?: string } => ({
    ...(typeof s.site === "string" ? { site: s.site } : {}),
    ...(typeof s.location === "string" ? { location: s.location } : {}),
  }),
})

/** NetBox-style elevations wall — every rack drawn side by side, so admins
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
    <div className="flex h-full flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" asChild className="h-6 px-1">
            <Link to="/racks">
              <ChevronLeft className="h-3 w-3" /> Racks
            </Link>
          </Button>
          <ChevronRight className="h-3 w-3 opacity-60" />
          <span className="font-semibold tracking-tight text-foreground">
            Elevations{siteName ? ` · ${siteName}` : ""}
          </span>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                className="ck ck-sm"
                checked={labels}
                onChange={(e) => setLabels(e.target.checked)}
              />
              Text
            </label>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading racks…</p>
        )}
        {q.isError && <QueryError error={q.error} />}
        {!q.isLoading && racks.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No racks{siteName ? ` at ${siteName}` : ""} yet.
          </p>
        )}
        {/* One column per rack, aligned at the top like a datacenter row. */}
        <div className="flex items-start gap-8 overflow-x-auto pb-4">
          {racks.map((r) => (
            <div key={r.id} className="shrink-0">
              <div className="mb-2 flex items-baseline gap-2">
                <Link
                  to="/racks/$id"
                  params={{ id: r.id }}
                  className="text-[13px] font-medium text-primary hover:underline"
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
      </div>
    </div>
  )
}
