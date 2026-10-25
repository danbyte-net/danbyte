import { useMemo, useState } from "react"
import { RotateCcw, Server } from "lucide-react"

import { Loading } from "@/components/loading"
import { BarButton, BarToggle } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ExportMenu } from "@/components/topology/export/export-menu"
import type { Application } from "@/lib/api"
import { useMe } from "@/lib/use-me"

import { appMapDocument } from "./document"
import { AppMapEmpty } from "./empty"
import { legendItems } from "./legend"
import type { AppMapView } from "./model"
import { AppMapStage } from "./stage"
import { movedFrom, NO_FILTERS, useAppMap } from "./use-app-map"
import type { AppMapFilters } from "./use-app-map"

// An application's Diagram tab (#163): the Application map, embedded and
// filtered to the application - its flows, or its place in the tree with
// its children and hosts - in the page's own theme, with the map's
// legend, panels and Export, and a way to the full map. Cards moved here
// stay put for the visit.

export function EmbeddedAppMap({ app }: { app: Application }) {
  const { me } = useMe()
  const [view, setView] = useState<AppMapView>("flows")
  const [hostsOn, setHostsOn] = useState(true)
  const [moved, setMoved] = useState<
    Record<AppMapView, Record<string, [number, number]>>
  >({ tree: {}, flows: {} })
  const filters: AppMapFilters = useMemo(
    () => ({ ...NO_FILTERS, applications: [app.id], hosts: hostsOn }),
    [app.id, hostsOn]
  )
  const positions = moved[view]
  const data = useAppMap({ view, filters, positions })
  const graph = data.graph
  const empty = !graph || graph.nodes.length === 0
  const name = `${app.name} - ${view === "tree" ? "tree" : "flows"}`

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs<AppMapView>
          value={view}
          onValueChange={setView}
          items={[
            { value: "flows", label: "Flows" },
            { value: "tree", label: "Tree" },
          ]}
        />
        {view === "tree" && (
          <BarToggle pressed={hostsOn} onClick={() => setHostsOn(!hostsOn)}>
            <Server /> Hosts
          </BarToggle>
        )}
        {Object.keys(positions).length > 0 && (
          <BarButton onClick={() => setMoved({ ...moved, [view]: {} })}>
            <RotateCcw /> Reset layout
          </BarButton>
        )}
        <div className="ml-auto flex items-center gap-2">
          <OpenLink to="/application-map" search={{ view, apps: app.id }}>
            Open in Application map
          </OpenLink>
          <ExportMenu
            name={name}
            fileStem={`${app.slug}-${view}`}
            pdfUrl="/api/diagram/export/pdf/?print=1"
            pdfKind="application-flows"
            areas={false}
            disabled={empty}
            legend={legendItems(view, data.flows)}
            document={() =>
              graph
                ? appMapDocument(graph, {
                    meta: {
                      title: app.name,
                      ...(me.active_tenant
                        ? { tenant: me.active_tenant.name }
                        : {}),
                      generated_at: new Date().toISOString(),
                      filters:
                        view === "tree"
                          ? "Tree"
                          : `${data.flows.length} ${
                              data.flows.length === 1 ? "flow" : "flows"
                            }`,
                      danbyte_url: `${window.location.origin}/applications/${app.id}`,
                    },
                    origin: window.location.origin,
                  })
                : null
            }
          />
        </div>
      </div>
      <div className="relative h-[560px] overflow-hidden rounded-lg border border-border bg-background">
        {data.error ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <QueryError error={data.error} />
          </div>
        ) : data.loading || !graph ? (
          <Loading className="absolute inset-0" />
        ) : empty ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <AppMapEmpty view={view} filtered={false} />
          </div>
        ) : (
          <AppMapStage
            graph={graph}
            view={view}
            fitKey={`${app.id}|${view}|${hostsOn}`}
            flows={data.flows}
            legendKey="app-map:legend:embedded"
            legendOpen={false}
            onMoved={(centres) => {
              if (data.base)
                setMoved({ ...moved, [view]: movedFrom(data.base, centres) })
            }}
          />
        )}
      </div>
    </div>
  )
}
