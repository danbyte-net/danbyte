import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useMemo, useRef } from "react"
import { Link as LinkIcon, PanelRight, RotateCcw, Server } from "lucide-react"

import { AppMapEmpty } from "@/components/application-map/empty"
import {
  AppMapFiltersPopover,
  hostOptions,
} from "@/components/application-map/filters"
import { legendItems } from "@/components/application-map/legend"
import { appMapDocument } from "@/components/application-map/document"
import {
  APP_MAP_VIEWS,
  decodePositions,
  encodePositions,
  matchCards,
  withoutHidden,
} from "@/components/application-map/model"
import type { AppMapView } from "@/components/application-map/model"
import { AppMapObjects } from "@/components/application-map/objects"
import { AppMapStage } from "@/components/application-map/stage"
import type { AppMapStageHandle } from "@/components/application-map/stage"
import {
  activeFilters,
  movedFrom,
  useAppMap,
} from "@/components/application-map/use-app-map"
import type { AppMapFilters } from "@/components/application-map/use-app-map"
import { HiddenChip } from "@/components/hidden-chip"
import { useStoredHidden } from "@/components/hidden-objects"
import { Loading } from "@/components/loading"
import { BarButton, BarToggle } from "@/components/map-toolbar"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ExportMenu } from "@/components/topology/export/export-menu"
import { Badge } from "@/components/ui/badge"
import type { FlowProtocol } from "@/lib/api"
import { copyWithToast } from "@/lib/clipboard"
import { FLOW_PROTOCOLS } from "@/lib/flows"
import { usePageTitle } from "@/lib/page-title"
import { useMe } from "@/lib/use-me"
import {
  useUrlCsv,
  useUrlEnum,
  useUrlFlag,
  useUrlPatch,
  useUrlText,
} from "@/lib/use-url-state"

/** The page's URL state: the view, the filters, the search, the Objects
 * sidebar, and each view's cards moved by hand (`tpos`, `fpos`). */
export interface AppMapSearch {
  view?: string
  apps?: string
  status?: string
  protocol?: string
  host?: string
  hosts?: string
  q?: string
  objects?: string
  tpos?: string
  fpos?: string
}

const KEYS = [
  "view",
  "apps",
  "status",
  "protocol",
  "host",
  "hosts",
  "q",
  "objects",
  "tpos",
  "fpos",
] as const

export const Route = createFileRoute("/application-map")({
  component: ApplicationMapPage,
  validateSearch: (s: Record<string, unknown>): AppMapSearch => {
    const out: AppMapSearch = {}
    for (const k of KEYS) {
      const v = s[k]
      // A flag arrives parsed (`hosts=0` as the number 0).
      if (typeof v === "string" && v) out[k] = v
      else if (typeof v === "number" || typeof v === "boolean")
        out[k] = String(Number(v))
    }
    return out
  },
})

// Maps → Application map (#163): the application catalog drawn by the
// topology Diagram's engine. Tree: the hierarchy as rows (by depth), each
// application a card with its installs and flows, and the devices and VMs
// it runs on under it. Flows: each application's flow ends in a row, a
// line per pair of ends with its protocols and ports, arrowed and coloured
// by status. A header (the view, Filters), a second bar (Hosts, Reset
// layout, Objects, Copy link, Export) and the map; everything in the URL,
// so a map is a link. The same map is an application's Diagram tab.

const NAME = "Application map"
const PROTOCOLS: readonly (FlowProtocol | "")[] = [
  "",
  ...FLOW_PROTOCOLS.map((p) => p.value),
]

function ApplicationMapPage() {
  usePageTitle(NAME)
  const { me } = useMe()
  const stage = useRef<AppMapStageHandle>(null)
  const patch = useUrlPatch()

  const [view, setView] = useUrlEnum<AppMapView>("view", "tree", APP_MAP_VIEWS)
  const [apps] = useUrlCsv("apps")
  const [status] = useUrlText("status")
  const [protocol] = useUrlEnum<FlowProtocol | "">("protocol", "", PROTOCOLS)
  const [host] = useUrlText("host")
  const [hostsOn, setHostsOn] = useUrlFlag("hosts", true)
  const [query, setQuery] = useUrlText("q", "", { replace: true })
  const [showObjects, setShowObjects] = useUrlFlag("objects", false)
  const [tpos] = useUrlText("tpos")
  const [fpos] = useUrlText("fpos")
  const posKey = view === "tree" ? "tpos" : "fpos"
  const posRaw = view === "tree" ? tpos : fpos

  const filters: AppMapFilters = useMemo(
    () => ({
      applications: apps ?? [],
      status,
      protocol,
      host,
      hosts: hostsOn,
    }),
    [apps, status, protocol, host, hostsOn]
  )
  const positions = useMemo(() => decodePositions(posRaw), [posRaw])
  const data = useAppMap({ view, filters, positions })

  const [stored, setStored] = useStoredHidden("app-map:hidden", ["node"])
  const hidden = useMemo(() => new Set(stored.node), [stored])
  const setHidden = useCallback(
    (next: Set<string>) => setStored({ node: [...next] }),
    [setStored]
  )
  const visible = useMemo(
    () => (data.graph ? withoutHidden(data.graph, hidden) : null),
    [data.graph, hidden]
  )
  const matched = useMemo(
    () => (data.graph ? matchCards(data.graph.nodes, query) : null),
    [data.graph, query]
  )
  const hiddenHere = data.graph
    ? data.graph.nodes.filter((n) => hidden.has(n.id)).length
    : 0
  const hosts = useMemo(
    () => hostOptions(data.installs, data.flows),
    [data.installs, data.flows]
  )

  const fitKey = [
    view,
    filters.applications.join(","),
    view === "flows" ? filters.status : "",
    view === "flows" ? filters.protocol : "",
    filters.host,
    view === "tree" ? String(filters.hosts) : "",
  ].join("|")

  const onFilters = (p: Partial<AppMapFilters>) =>
    patch({
      ...(p.applications
        ? {
            apps: p.applications.length ? p.applications.join(",") : undefined,
          }
        : {}),
      ...(p.status !== undefined ? { status: p.status || undefined } : {}),
      ...(p.protocol !== undefined
        ? { protocol: p.protocol || undefined }
        : {}),
      ...(p.host !== undefined ? { host: p.host || undefined } : {}),
    })

  const count =
    view === "tree"
      ? (visible?.nodes.filter((n) => n.data.ref.kind === "application")
          .length ?? 0)
      : data.flows.length
  const empty = !visible || visible.nodes.length === 0
  const filtered = activeFilters(filters, view) > 0

  const summary = [
    view === "tree" ? "Tree" : "Flows",
    filters.applications.length
      ? `${filters.applications.length} ${
          filters.applications.length === 1 ? "application" : "applications"
        }`
      : "",
    view === "flows" && filters.status
      ? `Status ${data.statuses.find((s) => s.id === filters.status)?.name ?? ""}`
      : "",
    view === "flows" && filters.protocol
      ? `Protocol ${FLOW_PROTOCOLS.find((p) => p.value === filters.protocol)?.label ?? ""}`
      : "",
    filters.host
      ? `Host ${hosts.find((h) => h.value === filters.host)?.label ?? ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6">
        <h1 className="shrink-0 text-base font-semibold">{NAME}</h1>
        {data.graph && (
          <Badge variant="secondary" className="min-w-24 shrink-0">
            <span className="num">{count}</span>{" "}
            {view === "tree"
              ? count === 1
                ? "application"
                : "applications"
              : count === 1
                ? "flow"
                : "flows"}
          </Badge>
        )}
        <SegmentedTabs<AppMapView>
          value={view}
          onValueChange={setView}
          items={[
            { value: "tree", label: "Tree" },
            { value: "flows", label: "Flows" },
          ]}
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <AppMapFiltersPopover
            view={view}
            value={filters}
            onChange={onFilters}
            applications={data.applications}
            statuses={data.statuses}
            hosts={hosts}
          />
        </div>
      </header>
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto border-b border-border px-4 lg:px-6">
        {view === "tree" && (
          <BarToggle pressed={hostsOn} onClick={() => setHostsOn(!hostsOn)}>
            <Server /> Hosts
          </BarToggle>
        )}
        {posRaw && (
          <BarButton
            onClick={() => patch({ [posKey]: undefined }, { replace: true })}
          >
            <RotateCcw /> Reset layout
          </BarButton>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <BarToggle
            pressed={showObjects}
            onClick={() => setShowObjects(!showObjects)}
          >
            <PanelRight /> Objects
          </BarToggle>
          <BarButton
            onClick={() =>
              void copyWithToast(window.location.href, "Link copied")
            }
          >
            <LinkIcon /> Copy link
          </BarButton>
          <ExportMenu
            name={NAME}
            fileStem={`application-map-${view}`}
            pdfUrl="/api/diagram/export/pdf/?print=1"
            pdfKind="application-flows"
            areas={false}
            disabled={empty}
            legend={legendItems(view, data.flows)}
            document={() =>
              visible
                ? appMapDocument(visible, {
                    meta: {
                      title: NAME,
                      ...(me.active_tenant
                        ? { tenant: me.active_tenant.name }
                        : {}),
                      generated_at: new Date().toISOString(),
                      filters: summary,
                      danbyte_url: window.location.href,
                    },
                    origin: window.location.origin,
                  })
                : null
            }
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {data.error ? (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <QueryError error={data.error} />
            </div>
          ) : data.loading || !visible ? (
            <Loading className="absolute inset-0" />
          ) : empty ? (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <AppMapEmpty
                view={view}
                filtered={filtered || hiddenHere > 0}
                onClear={() => {
                  onFilters({
                    applications: [],
                    status: "",
                    protocol: "",
                    host: "",
                  })
                  setHidden(new Set())
                }}
              />
            </div>
          ) : (
            <AppMapStage
              ref={stage}
              graph={visible}
              view={view}
              fitKey={fitKey}
              flows={data.flows}
              matched={matched}
              onMoved={(centres) => {
                if (!data.base) return
                const moved = movedFrom(data.base, centres)
                patch(
                  {
                    [posKey]: Object.keys(moved).length
                      ? encodePositions(moved)
                      : undefined,
                  },
                  { replace: true }
                )
              }}
              onHide={(id) => setHidden(new Set([...hidden, id]))}
              onShowFlows={(h) =>
                patch({ view: "flows", host: h, fpos: undefined })
              }
            />
          )}
          {!showObjects && (
            <HiddenChip
              count={hiddenHere}
              position="top-left"
              onShowAll={() => setHidden(new Set())}
            />
          )}
        </div>
        {showObjects && data.graph && (
          <AppMapObjects
            view={view}
            graph={data.graph}
            query={query}
            onQueryChange={setQuery}
            matched={matched}
            hidden={hidden}
            onHiddenChange={setHidden}
            onPick={(n) => {
              stage.current?.focusNode(n.id)
              stage.current?.select(n.id)
            }}
          />
        )}
      </div>
    </div>
  )
}
