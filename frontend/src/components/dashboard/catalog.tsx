import type { ReactNode } from "react"

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
import { OsmMapWidget } from "./widget-osm-map"

export type WidgetId =
  | "bookmarks"
  | "object-counts"
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
  | "map"

// Bento sizes → grid spans on a 6-col, ~168px auto-row grid.
export type WidgetSize = "sq" | "wide" | "big"
export const SIZE_CLASS: Record<WidgetSize, string> = {
  sq: "col-span-2 row-span-2",
  wide: "col-span-2 row-span-2 xl:col-span-3",
  big: "col-span-2 row-span-2 md:col-span-4 xl:col-span-4",
}

export interface WidgetDef {
  id: WidgetId
  title: string
  description: string
  size: WidgetSize
  render: (d: DashboardData) => ReactNode
}

export const CATALOG: WidgetDef[] = [
  {
    id: "bookmarks",
    title: "Bookmarks",
    description: "Your saved pages",
    size: "wide",
    render: () => <BookmarksWidget />,
  },
  {
    id: "object-counts",
    title: "Inventory",
    description: "Object counts across the tenant",
    size: "big",
    render: (d) => <ObjectCounts counts={d.counts} />,
  },
  {
    id: "recent-activity",
    title: "Recent activity",
    description: "Latest monitoring status changes",
    size: "wide",
    render: (d) => <RecentActivity rows={d.recent_activity} />,
  },
  {
    id: "recent-prefixes",
    title: "Recent prefixes",
    description: "Newest subnets",
    size: "wide",
    render: (d) => <RecentPrefixes rows={d.recent_prefixes} />,
  },
  {
    id: "recent-devices",
    title: "Recent devices",
    description: "Newest devices",
    size: "wide",
    render: (d) => <RecentDevices rows={d.recent_devices} />,
  },
  {
    id: "recent-ips",
    title: "Recent IP addresses",
    description: "Newest addresses",
    size: "wide",
    render: (d) => <RecentIps rows={d.recent_ips} />,
  },
  {
    id: "reachable-gauge",
    title: "Reachability",
    description: "Share of checks currently up",
    size: "sq",
    render: (d) => <RadialGauge value={d.reachable_pct} label="reachable" />,
  },
  {
    id: "ip-status",
    title: "IPs by status",
    description: "Address status breakdown",
    size: "sq",
    render: (d) => <DistDonut data={d.ip_by_status} unit="IPs" />,
  },
  {
    id: "ip-role",
    title: "IPs by role",
    description: "Address role breakdown",
    size: "sq",
    render: (d) => <DistDonut data={d.ip_by_role} unit="IPs" />,
  },
  {
    id: "ip-scope",
    title: "Public vs private IPs",
    description: "Address reachability split",
    size: "sq",
    render: (d) => <DistDonut data={d.ip_by_scope} unit="IPs" />,
  },
  {
    id: "prefix-family",
    title: "Prefixes by family",
    description: "IPv4 vs IPv6",
    size: "sq",
    render: (d) => <DistDonut data={d.prefix_by_family} unit="prefixes" />,
  },
  {
    id: "prefix-status",
    title: "Prefixes by status",
    description: "Container / active / reserved",
    size: "sq",
    render: (d) => <DistDonut data={d.prefix_by_status} unit="prefixes" />,
  },
  {
    id: "top-prefixes",
    title: "Top prefixes by utilisation",
    description: "Busiest subnets",
    size: "wide",
    render: (d) => <TopPrefixes data={d.top_prefixes} />,
  },
  {
    id: "device-status",
    title: "Devices by status",
    description: "Operational state",
    size: "sq",
    render: (d) => <DistDonut data={d.device_by_status} unit="devices" />,
  },
  {
    id: "device-type",
    title: "Devices by type",
    description: "Top device types",
    size: "wide",
    render: (d) => <DistBar data={d.device_by_type} />,
  },
  {
    id: "device-site",
    title: "Devices by site",
    description: "Where devices live",
    size: "wide",
    render: (d) => <DistBar data={d.device_by_site} />,
  },
  {
    id: "device-manufacturer",
    title: "Devices by manufacturer",
    description: "Vendor split",
    size: "wide",
    render: (d) => <DistBar data={d.device_by_manufacturer} />,
  },
  {
    id: "check-status",
    title: "Monitoring status",
    description: "Checks by current status",
    size: "sq",
    render: (d) => <DistDonut data={d.check_by_status} unit="checks" />,
  },
  {
    id: "alerts-severity",
    title: "Firing alerts",
    description: "Open alerts by severity",
    size: "sq",
    render: (d) => <DistDonut data={d.alerts_by_severity} unit="alerts" />,
  },
  {
    id: "map",
    title: "Map",
    description: "Your sites, devices, and cables on a live map",
    size: "big",
    render: () => <OsmMapWidget />,
  },
]

export const CATALOG_BY_ID = Object.fromEntries(
  CATALOG.map((w) => [w.id, w])
) as Record<WidgetId, WidgetDef>

// Table-first by default; charts stay one click away in "Add".
// Counts live in the always-on stat band, so the Inventory widget is opt-in.
export const DEFAULT_LAYOUT: WidgetId[] = [
  "bookmarks",
  "recent-prefixes",
  "recent-activity",
  "reachable-gauge",
  "recent-ips",
  "top-prefixes",
  "ip-status",
  "recent-devices",
  "device-status",
  "check-status",
]
