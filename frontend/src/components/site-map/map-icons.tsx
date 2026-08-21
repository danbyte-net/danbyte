import { renderToStaticMarkup } from "react-dom/server"
import L from "leaflet"

import { TileBadge } from "@/components/floorplan/tile-badge"
import { DynamicIcon } from "@/components/dynamic-icon"
import type { SiteMapDevice, SiteMapMarker, SiteMapSite } from "@/lib/api"

import { CHECK_COLOR } from "./status-colors"

// The divIcon factories for everything the map pins down - shared by the full
// /site-map route and the MiniMap so a site looks the same at every size.
// React components (TileBadge, DynamicIcon) are serialized with
// renderToStaticMarkup into the icon HTML; user strings go through escapeHtml.

export interface IconOpts {
  selected?: boolean
  /** MiniMap variant: smaller pin, no label chip (a tooltip stands in). */
  mini?: boolean
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function healthRing(check: string | null, mini = false): string {
  if (!check) return ""
  const c = CHECK_COLOR[check] ?? CHECK_COLOR.unknown
  const cls = mini ? "sm-health sm-health-mini" : "sm-health"
  return `<span class="${cls}" style="background:${c}"></span>`
}

// A user-supplied color lands inside a style attribute - only let an actual
// hex color through, anything else falls back to the theme pin.
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/

export function siteIcon(s: SiteMapSite, opts: IconOpts = {}): L.DivIcon {
  const { selected = false, mini = false } = opts
  const color = s.color && HEX_COLOR.test(s.color) ? s.color : ""
  // A custom pin color gets a white glyph; the default pin keeps the theme's
  // primary-foreground via CSS.
  const style = color ? ` style="background:${color};color:#fff"` : ""
  // Every site pin carries a glyph - the custom icon, or a standard building
  // so a site reads as "a building" at a glance rather than a bare dot.
  const glyph = renderToStaticMarkup(
    <DynamicIcon name={s.icon || "building-2"} className="sm-pin-icon" />
  )
  const count =
    !mini && s.device_count > 0
      ? `<span class="sm-count">${s.device_count}</span>`
      : ""
  const label = mini
    ? ""
    : `<span class="sm-label">${escapeHtml(s.name)}${count}</span>`
  return L.divIcon({
    className: "sm-marker" + (selected ? " sm-sel" : ""),
    html:
      `<span class="sm-pin${mini ? " sm-pin-mini" : ""}"${style}>${glyph}</span>` +
      healthRing(s.check, mini) +
      label,
    iconSize: undefined as unknown as L.PointExpression,
    iconAnchor: mini ? [9, 9] : [14, 14],
  })
}

export function deviceIcon(d: SiteMapDevice, opts: IconOpts = {}): L.DivIcon {
  const { selected = false, mini = false } = opts
  // The floorplan badge - a tinted square with the role's colour and icon
  // (a centred dot when the role has no icon). Same visual language as the
  // palette, the sidebar, and free markers.
  const badge = renderToStaticMarkup(
    <TileBadge color={d.role?.color} icon={d.role?.icon} />
  )
  const label = mini
    ? ""
    : `<span class="sm-devlabel" style="left:27px;top:2px">${escapeHtml(d.name)}</span>`
  return L.divIcon({
    className: "sm-marker" + (selected ? " sm-sel" : ""),
    html:
      `<span class="sm-badge">${badge}</span>${healthRing(d.check, mini)}` +
      label,
    iconAnchor: [12, 12],
  })
}

export function freeMarkerIcon(
  m: SiteMapMarker,
  opts: IconOpts = {}
): L.DivIcon {
  const { selected = false } = opts
  const label = m.label || m.device?.name || m.type?.name || ""
  // The same TileBadge as the palette/sidebar, rendered to static HTML for
  // the divIcon - a marker on the map looks identical to its sidebar row.
  // The .sm-badge wrapper gives the ~20% tint a solid backdrop over tiles.
  const badge = renderToStaticMarkup(
    <TileBadge color={m.type?.color} icon={m.type?.icon} />
  )
  return L.divIcon({
    className: "sm-marker" + (selected ? " sm-sel" : ""),
    html:
      `<span class="sm-badge">${badge}</span>` +
      (label
        ? `<span class="sm-devlabel" style="left:27px;top:2px">${escapeHtml(label)}</span>`
        : ""),
    iconAnchor: [12, 12],
  })
}
