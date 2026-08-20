import { lazy, type ReactNode } from "react"

import type { DashboardData } from "@/lib/api"
import {
  DistBar,
  DistDonut,
  ObjectCounts,
  RadialGauge,
  RecentActivity,
  TopPrefixes,
} from "./widget-charts-lazy"
import { RecentDevices, RecentIps, RecentPrefixes } from "./widget-tables"
import { BookmarksWidget } from "./widget-bookmarks"
import { ChangelogWidget } from "./widget-changelog"
import { OsmMapWidget } from "./widget-osm-map"
import { ExpiredCertsWidget, ExpiringCertsWidget } from "./widget-certificates"
import { CertHealthWidget } from "./widget-cert-health"
import { MyTasksWidget } from "./widget-tasks"

// Lazy - pulls in the floor-plan canvas only when the widget is actually shown.
const FloorplanWidget = lazy(() =>
  import("./widget-floorplan").then((m) => ({ default: m.FloorplanWidget }))
)

export type WidgetId =
  | "bookmarks"
  | "object-counts"
  | "changelog"
  | "recent-activity"
  | "recent-prefixes"
  | "recent-devices"
  | "recent-ips"
  | "reachable-gauge"
  | "ip-status"
  | "ip-role"
  | "ip-scope"
  | "prefix-family"
  | "prefix-status"
  | "top-prefixes"
  | "device-status"
  | "device-type"
  | "device-site"
  | "device-manufacturer"
  | "check-status"
  | "alerts-severity"
  | "expiring-certs"
  | "expired-certs"
  | "cert-health"
  | "my-tasks"
  | "map"
  | "floorplan"

import type { WidgetMeta } from "@/lib/dashboard-layout"

/** How a widget's body copes with a grid-imposed height (#41):
 * `scroll` - lists/tables scroll internally; `center` - fixed-size charts sit
 * centred; `stretch` - the child fills the cell (map, floor plan). */
export type WidgetFit = "scroll" | "center" | "stretch"

export interface WidgetDef {
  id: WidgetId
  title: string
  description: string
  fit?: WidgetFit
  render: (d: DashboardData) => ReactNode
}

// Default span + resize bounds per widget, in 6-column grid cells (~112px
// rows). Donuts keep a small ceiling - their charts are fixed-size, so a huge
// tile is empty border. Lists grow to full width; changelog/tasks/map to
// near-full dashboard, which is the #41 request.
const D: WidgetMeta = { span: { w: 2, h: 2 }, min: { w: 2, h: 2 }, max: { w: 6, h: 4 } }
const DONUT: WidgetMeta = { span: { w: 2, h: 2 }, min: { w: 1, h: 2 }, max: { w: 3, h: 3 } }
const BIGGY: WidgetMeta = { span: { w: 3, h: 3 }, min: { w: 2, h: 2 }, max: { w: 6, h: 6 } }
export const LAYOUT_META: Partial<Record<WidgetId, WidgetMeta>> = {
  "reachable-gauge": DONUT, "ip-status": DONUT, "ip-role": DONUT,
  "ip-scope": DONUT, "prefix-family": DONUT, "prefix-status": DONUT,
  "device-status": DONUT, "check-status": DONUT, "alerts-severity": DONUT,
  "object-counts": { span: { w: 4, h: 2 }, min: { w: 2, h: 2 }, max: { w: 6, h: 4 } },
  bookmarks: { span: { w: 2, h: 2 }, min: { w: 1, h: 1 }, max: { w: 4, h: 4 } },
  changelog: BIGGY,
  "my-tasks": { span: { w: 2, h: 3 }, min: { w: 2, h: 2 }, max: { w: 6, h: 6 } },
  "cert-health": { span: { w: 2, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 4 } },
  map: BIGGY,
  floorplan: BIGGY,
}

/** The built-in layout, hand-placed on the 6-column grid rather than flowed:
 * two big anchors up top, the status rings in a band, work queues, then the
 * tables, and the floor plan full-width at the bottom. This is also what
 * "Reset" gives you (when the tenant has no admin default). */
export const DEFAULT_GRID_LAYOUT: {
  id: WidgetId
  x: number
  y: number
  w: number
  h: number
}[] = [
  { id: "changelog", x: 0, y: 0, w: 3, h: 3 },
  { id: "map", x: 3, y: 0, w: 3, h: 3 },
  { id: "reachable-gauge", x: 0, y: 3, w: 2, h: 2 },
  { id: "check-status", x: 2, y: 3, w: 2, h: 2 },
  { id: "alerts-severity", x: 4, y: 3, w: 2, h: 2 },
  { id: "my-tasks", x: 0, y: 5, w: 2, h: 3 },
  { id: "recent-activity", x: 2, y: 5, w: 2, h: 3 },
  { id: "bookmarks", x: 4, y: 5, w: 2, h: 3 },
  { id: "ip-status", x: 0, y: 8, w: 2, h: 2 },
  { id: "device-status", x: 2, y: 8, w: 2, h: 2 },
  { id: "expiring-certs", x: 4, y: 8, w: 2, h: 2 },
  { id: "top-prefixes", x: 0, y: 10, w: 3, h: 2 },
  { id: "recent-devices", x: 3, y: 10, w: 3, h: 2 },
  { id: "recent-prefixes", x: 0, y: 12, w: 3, h: 2 },
  { id: "recent-ips", x: 3, y: 12, w: 3, h: 2 },
  { id: "device-type", x: 0, y: 14, w: 3, h: 2 },
  { id: "device-site", x: 3, y: 14, w: 3, h: 2 },
  { id: "floorplan", x: 0, y: 16, w: 6, h: 3 },
]

export function metaFor(id: string): WidgetMeta {
  return LAYOUT_META[id as WidgetId] ?? D
}

export const CATALOG: WidgetDef[] = [
  {
    id: "bookmarks",
    title: "Bookmarks",
    description: "Your saved pages",
    render: () => <BookmarksWidget />,
  },
  {
    id: "object-counts",
    title: "Inventory",
    description: "Object counts across the tenant",
    render: (d) => <ObjectCounts counts={d.counts} />,
  },
  {
    id: "changelog",
    title: "Changelog",
    description: "Recent changes across the tenant - who changed what",
    render: () => <ChangelogWidget />,
  },
  {
    id: "recent-activity",
    title: "Recent activity",
    description: "Latest monitoring status changes",
    render: (d) => <RecentActivity rows={d.recent_activity} />,
  },
  {
    id: "recent-prefixes",
    title: "Recent prefixes",
    description: "Newest subnets",
    render: (d) => <RecentPrefixes rows={d.recent_prefixes} />,
  },
  {
    id: "recent-devices",
    title: "Recent devices",
    description: "Newest devices",
    render: (d) => <RecentDevices rows={d.recent_devices} />,
  },
  {
    id: "recent-ips",
    title: "Recent IP addresses",
    description: "Newest addresses",
    render: (d) => <RecentIps rows={d.recent_ips} />,
  },
  {
    id: "reachable-gauge",
    fit: "center",
    title: "Reachability",
    description: "Share of checks currently up",
    render: (d) => <RadialGauge value={d.reachable_pct} label="reachable" />,
  },
  {
    id: "ip-status",
    fit: "center",
    title: "IPs by status",
    description: "Address status breakdown",
    render: (d) => (
      <DistDonut
        data={d.ip_by_status}
        unit="IPs"
        link={(x) => ({
          to: "/ips",
          search: x.key ? { status: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "ip-role",
    fit: "center",
    title: "IPs by role",
    description: "Address role breakdown",
    render: (d) => (
      <DistDonut
        data={d.ip_by_role}
        unit="IPs"
        link={(x) => ({
          to: "/ips",
          search: x.key ? { role: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "ip-scope",
    fit: "center",
    title: "Public vs private IPs",
    description: "Address reachability split",
    // Scope is a computed classification (public/private/cgnat/special). The
    // IP list applies it server-side via ?scope= and seeds the Scope facet.
    render: (d) => (
      <DistDonut
        data={d.ip_by_scope}
        unit="IPs"
        link={(x) => ({
          to: "/ips",
          search: x.key ? { scope: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "prefix-family",
    fit: "center",
    title: "Prefixes by family",
    description: "IPv4 vs IPv6",
    render: (d) => (
      <DistDonut
        data={d.prefix_by_family}
        unit="prefixes"
        link={(x) => ({
          to: "/prefixes",
          search: x.key ? { family: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "prefix-status",
    fit: "center",
    title: "Prefixes by status",
    description: "Container / active / reserved",
    render: (d) => (
      <DistDonut
        data={d.prefix_by_status}
        unit="prefixes"
        link={(x) => ({
          to: "/prefixes",
          search: x.key ? { status: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "top-prefixes",
    title: "Top prefixes by utilisation",
    description: "Busiest subnets",
    render: (d) => <TopPrefixes data={d.top_prefixes} />,
  },
  {
    id: "device-status",
    fit: "center",
    title: "Devices by status",
    description: "Operational state",
    render: (d) => (
      <DistDonut
        data={d.device_by_status}
        unit="devices"
        link={(x) => ({
          to: "/devices",
          search: x.key ? { status: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "device-type",
    title: "Devices by type",
    description: "Top device types",
    render: (d) => (
      <DistBar
        data={d.device_by_type}
        link={(x) => ({
          to: "/devices",
          search: x.key ? { type: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "device-site",
    title: "Devices by site",
    description: "Where devices live",
    render: (d) => (
      <DistBar
        data={d.device_by_site}
        link={(x) => ({
          to: "/devices",
          search: x.key ? { site: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "device-manufacturer",
    title: "Devices by manufacturer",
    description: "Vendor split",
    render: (d) => (
      <DistBar
        data={d.device_by_manufacturer}
        link={(x) => ({
          to: "/devices",
          search: x.key ? { manufacturer: x.key } : undefined,
        })}
      />
    ),
  },
  {
    id: "check-status",
    fit: "center",
    title: "Monitoring status",
    description: "Checks by current status",
    render: (d) => (
      <DistDonut
        data={d.check_by_status}
        unit="checks"
        link={(x) => ({
          to: "/monitoring",
          search: x.key
            ? { view: "checks", status: x.key }
            : { view: "checks" },
        })}
      />
    ),
  },
  {
    id: "alerts-severity",
    fit: "center",
    title: "Firing alerts",
    description: "Open alerts by severity",
    render: (d) => (
      <DistDonut
        data={d.alerts_by_severity}
        unit="alerts"
        link={(x) => ({
          to: "/alerts",
          search: x.key
            ? { state: "firing", severity: x.key }
            : { state: "firing" },
        })}
      />
    ),
  },
  {
    id: "my-tasks",
    title: "My tasks",
    description: "Your open planning tasks, most urgent first",
    render: () => <MyTasksWidget />,
  },
  {
    id: "cert-health",
    title: "Certificate health",
    description: "Expiry buckets across the certificate inventory",
    render: () => <CertHealthWidget />,
  },
  {
    id: "expiring-certs",
    title: "Expiring certificates",
    description: "Certificates expired or expiring within 30 days",
    render: () => <ExpiringCertsWidget />,
  },
  {
    id: "expired-certs",
    title: "Expired certificates",
    description: "Certificates already past their expiry date",
    render: () => <ExpiredCertsWidget />,
  },
  {
    id: "map",
    fit: "stretch",
    title: "Map",
    description: "Your sites, devices, and cables on a live map",
    render: () => <OsmMapWidget />,
  },
  {
    id: "floorplan",
    fit: "stretch",
    title: "Floor plan",
    description: "A floor plan with live tile status",
    render: () => <FloorplanWidget />,
  },
]

export const CATALOG_BY_ID = Object.fromEntries(
  CATALOG.map((w) => [w.id, w])
) as Record<WidgetId, WidgetDef>

// Table-first by default; charts stay one click away in "Add".
// Counts live in the always-on stat band, so the Inventory widget is opt-in.
export const DEFAULT_LAYOUT: WidgetId[] = [
  "my-tasks",
  "bookmarks",
  "changelog",
  "recent-activity",
  "reachable-gauge",
  "check-status",
  "alerts-severity",
  "expiring-certs",
  "map",
  "top-prefixes",
  "ip-status",
  "recent-prefixes",
  "recent-ips",
  "device-status",
  "device-type",
  "device-site",
  "recent-devices",
  "floorplan",
]
