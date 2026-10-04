import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FloorPlanLiveState, Rack } from "@/lib/api"
import { CapacityBar } from "@/components/cells/capacity-bar"
import { ColorBadge } from "@/components/cells/color-badge"
import { PortsFigure } from "@/components/cells/ports-figure"
import { PowerFigure } from "@/components/cells/power-figure"
import { RowCheckBadge } from "@/components/foldable-group"
import { PanelRow } from "@/components/map-panel"
import { BarButton, BarTip } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { StatusBadge } from "@/components/status-badge"
import { LEGEND_PILL } from "@/components/map-legend"
import { WITH_PORTS } from "@/lib/port-utilization"
import { capacityRatio, hasPowerData } from "@/lib/rack-capacity"

import type { SceneTile } from "./world"

/**
 * The card for the rack selected in the 3D room: its name and height, how
 * full it is - space, power, ports and panel ports, as the rack page and the
 * floor plan read them - its role and status as their pills, live
 * monitoring, and the focus / flip / isolate controls with the jump-off.
 *
 * The figures come from the plan's racks when the plan has them (it is
 * coloured by them, or the popover shows ports); otherwise the card asks
 * for this one rack, the request the rack page makes.
 */
export function RackHud({
  tile,
  liveState,
  info,
  focused,
  viewSide,
  onToggleFocus,
  onFlip,
  onIsolateRow,
  onIsolateZone,
}: {
  tile: SceneTile
  liveState: FloorPlanLiveState | null
  /** The rack from the plan's racks, when loaded. */
  info?: Rack | null
  focused: boolean
  viewSide: "front" | "rear"
  onToggleFocus: () => void
  onFlip: () => void
  onIsolateRow: () => void
  /** Present only when the rack stands in a zone (smallest zone wins). */
  onIsolateZone?: () => void
}) {
  const rack = tile.rack!
  const live = liveState?.tiles[tile.id]
  const rackLive = live?.kind === "rack" ? live : null
  const own = useQuery({
    queryKey: ["rack", rack.id, WITH_PORTS],
    queryFn: () => api<Rack>(`/api/racks/${rack.id}/?include=ports`),
    enabled: !info,
  })
  const detail = info ?? own.data ?? null
  const used = rackLive?.used_units ?? detail?.used_units ?? null
  const height = rackLive?.u_height ?? rack.u_height
  const power = rackLive?.power ?? detail?.power ?? null
  const devices = rackLive?.device_count ?? rack.devices.length
  const panel = detail?.panel_ports
  return (
    <div className="absolute top-3 left-3 w-64 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[13px] font-semibold">
          {tile.label || rack.name}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <RowCheckBadge check={live?.check} />
          <span className="num">{rack.u_height}U</span>
        </span>
      </div>
      <div className="mt-1.5 grid">
        <PanelRow label="Devices">
          <span className="num">{devices}</span>
        </PanelRow>
        {used != null && (
          <PanelRow label="Space">
            <span className="inline-flex items-center gap-2">
              <CapacityBar
                ratio={capacityRatio(used, height)}
                className="w-10"
              />
              <span className="num text-[11px] text-muted-foreground">
                {used}/{height}U
              </span>
            </span>
          </PanelRow>
        )}
        {hasPowerData(power) && (
          <PanelRow label="Power">
            <PowerFigure power={power} bar barClassName="w-10" />
          </PanelRow>
        )}
        {detail?.ports && detail.ports.total > 0 && (
          <PanelRow label="Ports">
            <PortsFigure row={detail.ports} bar barClassName="w-10" />
          </PanelRow>
        )}
        {panel && panel.total > 0 && (
          <PanelRow label="Panel ports">
            <PortsFigure row={panel} bar barClassName="w-10" />
          </PanelRow>
        )}
        {detail?.role && (
          <PanelRow label="Role">
            <ColorBadge
              name={detail.role.name}
              color={detail.role.color || undefined}
              className={LEGEND_PILL}
            />
          </PanelRow>
        )}
        {detail?.status && (
          <PanelRow label="Status">
            <StatusBadge status={detail.status} className={LEGEND_PILL} />
          </PanelRow>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        double-click to zoom in
      </p>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <BarTip tip="Focus" shortcut="F">
          <BarButton
            variant={focused ? "default" : "outline"}
            onClick={onToggleFocus}
          >
            Focus
          </BarButton>
        </BarTip>
        <BarButton onClick={onFlip}>
          {viewSide === "front" ? "View rear" : "View front"}
        </BarButton>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <BarButton
          className={onIsolateZone ? undefined : "col-span-2"}
          onClick={onIsolateRow}
        >
          Isolate row
        </BarButton>
        {onIsolateZone && (
          <BarButton onClick={onIsolateZone}>Isolate zone</BarButton>
        )}
      </div>
      <OpenLink
        to="/racks/$id"
        params={{ id: rack.id }}
        className="mt-1.5 w-full"
      >
        Open rack
      </OpenLink>
    </div>
  )
}
