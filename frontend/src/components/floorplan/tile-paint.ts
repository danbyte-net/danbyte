/**
 * How a tile on the 2D floor plan is painted, and what the plan's
 * **Color by** choice does to it (#247).
 *
 * One rule per tile, kept pure so it can be tested on its own: the colour a
 * rack is coloured by goes on the tile's **fill**, the live monitoring state
 * stays on its **stroke** (a down rack is outlined red whatever its fill),
 * and in a capacity mode the rack's figure is always written on the tile -
 * `86%`, or `No data` - so the reading never rests on colour alone. The 3D
 * room takes the same colour as the rack's tint (`rackTint`).
 */

import type {
  FloorPlanTile,
  FloorTileRackState,
  PortCountRow,
  Rack,
  RackPower,
  StatusMini,
} from "@/lib/api"
import { portsRatio } from "@/components/cells/ports-figure"
import {
  CAPACITY_NONE_HEX,
  capacityColor,
  capacityRatio,
  rackPowerRatio,
} from "@/lib/rack-capacity"

/** What the plan colours its racks by. `type` is the plan as it always
 * looked: every tile in its type's colour. */
export const COLOR_BY = [
  "type",
  "space",
  "power",
  "ports",
  "panel_ports",
  "role",
  "status",
] as const
export type ColorBy = (typeof COLOR_BY)[number]

/** The Display popover's words for each choice. */
export const COLOR_BY_LABEL: Record<ColorBy, string> = {
  type: "Type",
  space: "Space",
  power: "Power",
  ports: "Ports",
  panel_ports: "Panel ports",
  role: "Rack role",
  status: "Status",
}

/** The choices that read how full a rack is, on the 80 / 95 % scale. */
export type CapacityMetric = "space" | "power" | "ports" | "panel_ports"

export function isCapacityMetric(c: ColorBy): c is CapacityMetric {
  return c === "space" || c === "power" || c === "ports" || c === "panel_ports"
}

/** The stored choice (`plan.state.color_by`), anything unknown read as
 * `type`. */
export function readColorBy(raw: unknown): ColorBy {
  return COLOR_BY.includes(raw as ColorBy) ? (raw as ColorBy) : "type"
}

/** A tile's own colour: its override, else its type's, else its role's. */
export function tileFill(
  t: Pick<FloorPlanTile, "color" | "tile_type" | "role_type">
): string {
  return t.color || t.tile_type?.color || t.role_type?.color || "#a1a1aa"
}

/** Monitoring worst-status → the tile's stroke. */
export const CHECK_COLOR: Record<string, string> = {
  down: "#ef4444",
  stale: "#ef4444",
  degraded: "#f59e0b",
}

/** What a rack tile's colouring reads: its units and power - the live
 * poll's where the poll has them - and, from the plan's racks, its port
 * figures, role and status. A field the plan has not loaded is undefined. */
export interface RackFigures {
  used_units: number
  u_height: number
  power: RackPower
  ports?: PortCountRow | null
  panel_ports?: PortCountRow | null
  role?: { name: string; color: string } | null
  status?: StatusMini | null
}

/** A rack's figures: the plan's rack row, its units and power refreshed by
 * the tile's live state (polled every 30 s). Either may be missing - a rack
 * you cannot view has live figures only. Null when there is neither. */
export function rackFigures(
  rack: Rack | null | undefined,
  live: FloorTileRackState | null | undefined
): RackFigures | null {
  if (!rack && !live) return null
  return {
    used_units: live?.used_units ?? rack?.used_units ?? 0,
    u_height: live?.u_height ?? rack?.u_height ?? 0,
    power: live?.power ??
      rack?.power ?? { available_w: 0, allocated_w: 0, maximum_w: 0 },
    ports: rack?.ports,
    panel_ports: rack?.panel_ports,
    role: rack?.role,
    status: rack?.status,
  }
}

/** How full a rack is on one measure, 0-1 (above 1 when over); null when
 * there is nothing to measure against - no feed, no ports. */
export function metricRatio(
  fig: RackFigures,
  metric: CapacityMetric
): number | null {
  switch (metric) {
    case "space":
      return capacityRatio(fig.used_units, fig.u_height)
    case "power":
      return rackPowerRatio(fig.power)
    case "ports":
      return portsRatio(fig.ports)
    case "panel_ports":
      return portsRatio(fig.panel_ports)
  }
}

/** A ratio as the tile writes it: `86%`, `No data` with nothing to measure. */
export function figureText(ratio: number | null): string {
  return ratio == null ? "No data" : `${Math.round(ratio * 100)}%`
}

/** The colour a rack is coloured by under `colorBy`, or null for `type`:
 * a capacity measure's level (grey without data), else its role's or its
 * status's own colour (grey without one). The 2D fill and the 3D tint. */
export function rackTint(
  colorBy: ColorBy,
  fig: RackFigures | null
): string | null {
  if (colorBy === "type") return null
  if (isCapacityMetric(colorBy))
    return capacityColor(fig ? metricRatio(fig, colorBy) : null)
  const own = colorBy === "role" ? fig?.role?.color : fig?.status?.color
  return own || CAPACITY_NONE_HEX
}

/** Everything that decides one tile's look. */
export interface TilePaintInput {
  tile: Pick<FloorPlanTile, "color" | "tile_type" | "role_type" | "linked"> & {
    status?: FloorPlanTile["status"]
  }
  colorBy: ColorBy
  /** The rack's figures, for a tile linked to a rack; null otherwise or
   * before anything is known about it. */
  rack: RackFigures | null
  /** The live monitoring roll-up, when the poll has one. */
  check?: string | null
  selected?: boolean
  /** Outside the rack table's filter: the plan fades it. */
  dimmed?: boolean
}

/** One tile's paint. Positions and sizes stay `TileShape`'s. */
export interface TilePaint {
  fill: string
  fillOpacity: number
  stroke: string
  strokeOpacity: number
  strokeWidth: number
  /** Monitoring owns the stroke: a check is down, stale or degraded. */
  alarm: boolean
  /** The figure along the tile's foot: the bar's share and colour, and the
   * text. `always` - write it even on a one-cell tile (a capacity mode). */
  figure: {
    ratio: number | null
    color: string
    text: string
    always: boolean
  } | null
  /** The colouring is not about this tile (it is not a rack): neutral and
   * faint, so the racks read. */
  muted: boolean
  /** The whole tile's opacity: faded when decommissioning or filtered out. */
  opacity: number
}

/** Fill strength of a tile coloured by what it says about its rack. */
export const STATE_FILL_OPACITY = 0.35

/**
 * Paint one non-zone tile.
 *
 * - **Type** (the default) is the plan as it always looked: the tile's own
 *   colour, heavier when it links an object, a rack's space bar along its
 *   foot.
 * - **Space, Power, Ports, Panel ports** fill a rack's tile with its level
 *   on the 80 / 95 % scale, grey for no data, and write the figure on it.
 * - **Rack role, Status** fill it with the role's or the status's own
 *   colour, grey for none, and keep the space bar.
 *
 * Outside Type, a tile that is no rack turns neutral and faint. Monitoring
 * keeps the stroke in every mode.
 */
export function tilePaint({
  tile,
  colorBy,
  rack,
  check = null,
  selected = false,
  dimmed = false,
}: TilePaintInput): TilePaint {
  const alarmColor = check ? CHECK_COLOR[check] : undefined
  const alarm = !!alarmColor
  const isRack = tile.linked?.kind === "rack"
  const space = rack ? capacityRatio(rack.used_units, rack.u_height) : null
  const spaceFigure =
    space == null
      ? null
      : {
          ratio: space,
          color: capacityColor(space),
          text: figureText(space),
          always: false,
        }
  const opacity = dimmed ? 0.25 : tile.status === "decommissioning" ? 0.55 : 1

  let fill = tileFill(tile)
  let fillOpacity = tile.linked ? 0.26 : 0.13
  let figure: TilePaint["figure"] = isRack ? spaceFigure : null
  let muted = false

  if (colorBy !== "type") {
    if (!isRack) {
      fill = CAPACITY_NONE_HEX
      fillOpacity = 0.06
      figure = null
      muted = true
    } else {
      fill = rackTint(colorBy, rack) ?? fill
      fillOpacity = STATE_FILL_OPACITY
      if (isCapacityMetric(colorBy)) {
        const ratio = rack ? metricRatio(rack, colorBy) : null
        figure = {
          ratio,
          color: capacityColor(ratio),
          text: figureText(ratio),
          always: true,
        }
      }
    }
  }

  return {
    fill,
    fillOpacity,
    stroke: alarmColor ?? fill,
    strokeOpacity: selected || alarm ? 1 : muted ? 0.3 : 0.55,
    strokeWidth: selected || alarm ? 2 : 1,
    alarm,
    figure,
    muted,
    opacity,
  }
}

/** One frame-stamp part for the 3D room: changes whenever any rack's tint
 * does, so the room - which only draws on demand - redraws the moment a
 * colour does (a missed redraw leaves the old colours frozen on screen). */
export function tintStamp(tints: ReadonlyMap<string, string>): string {
  return [...tints]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, c]) => `${id}:${c}`)
    .join(",")
}
