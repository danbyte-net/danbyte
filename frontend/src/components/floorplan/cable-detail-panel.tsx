import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Copy, Crosshair, Route } from "lucide-react"

import { api } from "@/lib/api"
import type {
  FloorPlanCableFar,
  FloorPlanCablePanel,
  FloorPlanCablePanelEnd,
  FloorPlanCablePath,
  FloorPlanTray,
  TraceGraph,
} from "@/lib/api"
import { copyWithToast } from "@/lib/clipboard"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { BarButton } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import {
  IncompleteBadge,
  linearizeTrace,
  traceUrl,
} from "@/components/cable-trace-path"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import {
  formatMetres,
  formatStoredLength,
  routeLengthM,
  storedLengthM,
} from "./cable-draw"
import type { CableRoute } from "./cable-draw"

/** The cable panel's payload - GET /api/floor-plans/{id}/cable-panel/{cable}/. */
export function useCablePanel(planId: string, cableId: string | null) {
  return useQuery({
    queryKey: ["floor-plan-cable-panel", planId, cableId],
    queryFn: () =>
      api<FloorPlanCablePanel>(
        `/api/floor-plans/${planId}/cable-panel/${cableId}/`
      ),
    enabled: !!cableId,
    staleTime: 30_000,
  })
}

/** Where an end is on this plan: its tile, or the floor it stands on. */
export interface CableEndPlace {
  tileId: string | null
  far: FloorPlanCableFar | null
}

/** Each end's place on the plan, from the plan's cable path. */
export function endPlaces(
  cp: FloorPlanCablePath | undefined
): Record<"A" | "B", CableEndPlace> {
  const one = (tiles: string[] | undefined, far?: FloorPlanCableFar[]) => ({
    tileId: tiles?.[0] ?? null,
    far: far?.[0] ?? null,
  })
  return {
    A: one(cp?.a_tiles, cp?.a_far),
    B: one(cp?.b_tiles, cp?.b_far),
  }
}

/** One compact line per hop of a multi-hop path: `device · port`. */
export function pathLines(
  g: TraceGraph,
  cableId: string
): { device: string; deviceId?: string; ports: string }[] | null {
  const steps = linearizeTrace(g, cableId)
  if (!steps) return null
  const chips = steps.flatMap((s) => (s.t === "chip" ? [s.chip] : []))
  if (chips.length < 3) return null
  return chips.map((c) => ({
    device: c.device,
    deviceId: c.circuit || c.powerPanel ? undefined : c.deviceId,
    ports: c.ports.map((p) => p.name).join(" ⇄ "),
  }))
}

/**
 * The cable panel: a cable traced on the plan, in full - its status, type,
 * colour and length, the route it takes here (documented or inferred, the
 * trays it rides, its riser, whether it is out of date), both ends' device
 * and port, and the whole path when the run passes through panels. Closing
 * it clears the trace.
 */
export function CableDetailPanel({
  planId,
  cableId,
  cablePath,
  route,
  trays,
  cellMm,
  onClose,
  onShowTile,
  onHighlightTray,
  onEditRoute,
}: {
  planId: string
  cableId: string
  /** The cable as the plan draws it (its ends' tiles, its stored path). */
  cablePath?: FloorPlanCablePath
  route?: CableRoute
  trays: readonly FloorPlanTray[]
  cellMm: number
  onClose: () => void
  /** Pan the plan to one end's tile. */
  onShowTile: (tileId: string) => void
  /** Light one tray the route rides. */
  onHighlightTray: (trayId: string) => void
  /** Edit: re-route the cable (Update routes). */
  onEditRoute?: (cableId: string) => void
}) {
  const q = useCablePanel(planId, cableId)
  const c = q.data
  const name = c?.name || cablePath?.label || "Cable"
  return (
    <PanelShell
      label="Cable"
      title={name}
      titleText={name}
      onClose={onClose}
      footer={
        <>
          <OpenLink to="/cables/$id" params={{ id: cableId }}>
            Open cable
          </OpenLink>
          {onEditRoute && (
            <BarButton onClick={() => onEditRoute(cableId)}>
              <Route /> Edit route
            </BarButton>
          )}
        </>
      }
    >
      {q.isError ? (
        <QueryError error={q.error} />
      ) : !c ? (
        <Loading className="min-h-24" />
      ) : (
        <>
          <CableHeader c={c} cablePath={cablePath} />
          <RouteSection
            cablePath={cablePath}
            route={route}
            trays={trays}
            cellMm={cellMm}
            onHighlightTray={onHighlightTray}
          />
          {(["A", "B"] as const).map((end) => (
            <EndSection
              key={end}
              end={end}
              rows={c.ends[end]}
              place={endPlaces(cablePath)[end]}
              onShowTile={onShowTile}
            />
          ))}
          <PathSection cableId={cableId} />
        </>
      )}
    </PanelShell>
  )
}

const hex = (c: string) => (c.startsWith("#") ? c : `#${c}`)

function CableHeader({
  c,
  cablePath,
}: {
  c: FloorPlanCablePanel
  cablePath?: FloorPlanCablePath
}) {
  const label = c.label || c.name
  return (
    <PanelSection label="Cable">
      <PanelRow label="Label">
        <span className="inline-flex items-center gap-1">
          <span className="font-mono">{label}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy label"
                onClick={() => void copyWithToast(label, "Label copied")}
              >
                <Copy />
              </Button>
            </TooltipTrigger>
            <TooltipContent variant="default">Copy label</TooltipContent>
          </Tooltip>
        </span>
      </PanelRow>
      <PanelRow label="Status">
        <StatusBadge status={c.status} />
      </PanelRow>
      {c.type_display && <PanelRow label="Type">{c.type_display}</PanelRow>}
      {c.color && (
        <PanelRow label="Colour">
          <span className="inline-flex items-center gap-1.5">
            <span
              data-cable-swatch
              className="inline-block h-3 w-5 rounded-sm ring-1 ring-border"
              style={{ backgroundColor: hex(c.color) }}
            />
            <span className="font-mono text-[11px] text-muted-foreground">
              {hex(c.color)}
            </span>
          </span>
        </PanelRow>
      )}
      <PanelRow label="Length">
        {c.length == null ? (
          "-"
        ) : (
          <span className="num">
            {cablePath ? formatStoredLength(cablePath) : `${c.length}`}
            <span className="text-muted-foreground">
              {" · "}
              {c.length_source === "computed" ? "computed" : "entered"}
            </span>
          </span>
        )}
      </PanelRow>
      {c.description && (
        <PanelRow label="Description">{c.description}</PanelRow>
      )}
    </PanelSection>
  )
}

function RouteSection({
  cablePath,
  route,
  trays,
  cellMm,
  onHighlightTray,
}: {
  cablePath?: FloorPlanCablePath
  route?: CableRoute
  trays: readonly FloorPlanTray[]
  cellMm: number
  onHighlightTray: (trayId: string) => void
}) {
  if (!cablePath) return null
  const computed = route ? routeLengthM(route, cellMm) : null
  const stored = storedLengthM(cablePath)
  const delta = computed != null && stored != null ? computed - stored : null
  const rode = (route?.trayIds ?? cablePath.tray_ids)
    .map((id) => trays.find((t) => t.id === id))
    .filter((t): t is FloorPlanTray => !!t)
  const riser = cablePath.path?.riser
  return (
    <PanelSection label="Route">
      {route?.stale && (
        <div className="mb-1">
          <Badge variant="warning">Out of date</Badge>
        </div>
      )}
      <PanelRow label="Route">
        {route
          ? route.stored
            ? "Documented"
            : "Inferred"
          : "Not on this plan"}
      </PanelRow>
      {computed != null && (
        <PanelRow label="Route length">
          <span className="num">
            {formatMetres(computed)}
            {delta != null && Math.abs(delta) >= 0.05 && (
              <span className="text-muted-foreground">
                {" "}
                ({delta > 0 ? "+" : "−"}
                {formatMetres(Math.abs(delta))})
              </span>
            )}
          </span>
        </PanelRow>
      )}
      <PanelRow label="Trays">
        {rode.length ? (
          <span className="inline-flex flex-wrap justify-end gap-1">
            {rode.map((t) => (
              <button
                key={t.id}
                type="button"
                data-tray-link={t.id}
                onClick={() => onHighlightTray(t.id)}
                className="rounded-md border border-border px-1.5 py-px text-[11px] hover:bg-muted"
              >
                {t.name || "Tray"}
              </button>
            ))}
          </span>
        ) : (
          "Direct"
        )}
      </PanelRow>
      {riser && (
        <PanelRow label="Riser">
          {[riser.label || "Riser", riser.floor_plan?.name]
            .filter(Boolean)
            .join(" → ")}
        </PanelRow>
      )}
    </PanelSection>
  )
}

function EndSection({
  end,
  rows,
  place,
  onShowTile,
}: {
  end: "A" | "B"
  rows: FloorPlanCablePanelEnd[]
  place: CableEndPlace
  onShowTile: (tileId: string) => void
}) {
  const label = `${end} end`
  if (!rows.length)
    return (
      <PanelSection label={label}>
        <span className="text-muted-foreground">Not connected</span>
      </PanelSection>
    )
  return (
    <PanelSection label={label}>
      {rows.map((row, i) => (
        <div
          key={i}
          data-cable-end={end}
          className="mt-1 rounded-md border border-border p-2 first:mt-0"
        >
          <EndCard
            row={row}
            place={i === 0 ? place : null}
            onShow={onShowTile}
          />
        </div>
      ))}
    </PanelSection>
  )
}

function EndCard({
  row,
  place,
  onShow,
}: {
  row: FloorPlanCablePanelEnd
  place: CableEndPlace | null
  onShow: (tileId: string) => void
}) {
  if (row.hidden) return <span className="text-muted-foreground">Hidden</span>
  const d = row.device
  const p = row.port
  const where = d
    ? [
        d.site?.name,
        d.location?.name,
        d.rack
          ? `${d.rack.name}${d.position != null ? ` · U${d.position}` : ""}`
          : d.cabinet?.name,
      ].filter(Boolean)
    : []
  const live = p?.observed
  return (
    <>
      {d ? (
        <div className="flex flex-wrap items-center gap-1">
          <Link
            to="/devices/$id"
            params={{ id: d.id }}
            className="link min-w-0 font-mono font-medium break-all"
          >
            {d.name}
          </Link>
          {d.role && (
            <ColorBadge
              name={d.role.name}
              color={d.role.color || undefined}
              className="h-4 px-1.5 text-[10px]"
            />
          )}
          {d.status && (
            <StatusBadge status={d.status} className="h-4 px-1.5 text-[10px]" />
          )}
        </div>
      ) : null}
      {where.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {where.join(" · ")}
        </div>
      )}
      {p && (
        <div className="mt-1.5">
          <PanelRow label="Port">
            <span className="font-mono">{p.name}</span>
          </PanelRow>
          {p.type_display && <PanelRow label="Type">{p.type_display}</PanelRow>}
          {p.speed && <PanelRow label="Speed">{p.speed}</PanelRow>}
          {p.enabled != null && (
            <PanelRow label="Enabled">{p.enabled ? "Yes" : "No"}</PanelRow>
          )}
          {live && (
            <PanelRow label="Live">
              <Badge
                variant={
                  live.oper_status === "up"
                    ? "success"
                    : live.admin_status === "down"
                      ? "secondary"
                      : "destructive"
                }
              >
                {live.admin_status === "down"
                  ? "Admin down"
                  : live.oper_status === "up"
                    ? "Up"
                    : "Down"}
              </Badge>
            </PanelRow>
          )}
          {p.vlan && (
            <PanelRow label="Untagged">
              <ColorBadge
                name={`${p.vlan.vlan_id} · ${p.vlan.name}`}
                color={p.vlan.color || undefined}
                className="h-4 px-1.5 text-[10px]"
              />
            </PanelRow>
          )}
          {!!p.ip_addresses?.length && (
            <PanelRow label="IPs">
              <span className="font-mono">
                {p.ip_addresses.map((ip) => (
                  <span key={ip.id} className="block">
                    {ip.ip_address}
                  </span>
                ))}
              </span>
            </PanelRow>
          )}
          {p.description && (
            <PanelRow label="Description">{p.description}</PanelRow>
          )}
        </div>
      )}
      {place && (place.tileId || place.far) && (
        <div className="mt-1.5">
          {place.tileId ? (
            <BarButton className="w-full" onClick={() => onShow(place.tileId!)}>
              <Crosshair /> Show on plan
            </BarButton>
          ) : place.far && !place.far.hidden && place.far.floor_plan ? (
            <BarButton asChild className="w-full">
              <Link
                to="/floorplans/$id"
                params={{ id: place.far.floor_plan.id }}
              >
                On {place.far.floor_plan.name}
              </Link>
            </BarButton>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Not on this plan
            </span>
          )}
        </div>
      )}
    </>
  )
}

/** The whole run when it passes through panels: one line per device. */
function PathSection({ cableId }: { cableId: string }) {
  const q = useQuery({
    queryKey: ["trace", "cable", cableId],
    queryFn: () => api<TraceGraph>(traceUrl("cable", cableId)),
    staleTime: 30_000,
  })
  if (!q.data) return null
  const lines = pathLines(q.data, cableId)
  if (!lines) return null
  return (
    <PanelSection label="Path">
      {!q.data.complete && (
        <div className="mb-1">
          <IncompleteBadge />
        </div>
      )}
      <ol className="grid gap-0.5">
        {lines.map((l, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="num w-4 shrink-0 text-right text-[10px] text-muted-foreground">
              {i + 1}
            </span>
            {l.deviceId ? (
              <Link
                to="/devices/$id"
                params={{ id: l.deviceId }}
                className="link min-w-0 font-mono break-all"
              >
                {l.device}
              </Link>
            ) : (
              <span className="min-w-0 font-mono break-all">{l.device}</span>
            )}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
              {l.ports}
            </span>
          </li>
        ))}
      </ol>
    </PanelSection>
  )
}
