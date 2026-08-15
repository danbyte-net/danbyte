import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { WirelessLAN } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of wireless LANs". The /wireless-lans
// list and the WLANs pane on a wireless LAN group's detail page both build
// their columns here, so a WLAN row reads identically in both places. Facet
// meta (useTableFilters) is attached where it makes sense; panes that don't
// draw a facet rail simply ignore it.

export type WirelessLANColumnId =
  | "numid"
  | "ssid"
  | "group"
  | "status"
  | "vlan"
  | "auth"
  | "description"
  | "tags"

const CANONICAL_ORDER: WirelessLANColumnId[] = [
  "numid",
  "ssid",
  "group",
  "status",
  "vlan",
  "auth",
  "description",
  "tags",
]

export interface WirelessLANColumnOpts<T extends WirelessLAN = WirelessLAN> {
  /** Drop columns (e.g. a group's own page omits "group"). */
  omit?: WirelessLANColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: WirelessLANColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildWirelessLANColumns<T extends WirelessLAN = WirelessLAN>(
  opts: WirelessLANColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: WirelessLANColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<WirelessLANColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    ssid: () => ({
      id: "ssid",
      accessorKey: "ssid",
      header: ({ column }) => <SortHeader column={column} label="SSID" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/wireless-lans/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.ssid}
          </Link>
          <PlannedChangeMarker
            objectType="api.wirelesslan"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    group: () => ({
      id: "group",
      accessorFn: (w) => w.group?.name ?? "",
      header: "Group",
      cell: ({ row }) =>
        row.original.group ? (
          <Link
            to="/wireless-lan-groups/$id"
            params={{ id: row.original.group.id }}
            className="text-xs hover:underline"
          >
            {row.original.group.name}
          </Link>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Group",
          get: (r: T) => r.group?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.group?.name ?? "No group",
          }),
        },
      },
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    }),
    vlan: () => ({
      id: "vlan",
      accessorFn: (w) => w.vlan?.vlan_id ?? "",
      header: "VLAN",
      cell: ({ row }) =>
        row.original.vlan ? (
          <span className="text-xs">
            <span className="font-mono">{row.original.vlan.vlan_id}</span>{" "}
            <span className="text-muted-foreground">
              {row.original.vlan.name}
            </span>
          </span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "VLAN",
          get: (r: T) => r.vlan?.id ?? "__none__",
          formatValue: (_v, sample) => ({ label: sample.vlan?.name ?? "—" }),
        },
      },
    }),
    auth: () => ({
      id: "auth",
      accessorKey: "auth_type",
      header: "Auth",
      cell: ({ row }) =>
        row.original.auth_type ? (
          <span className="text-xs">
            {row.original.auth_type_display}
            {row.original.auth_cipher && (
              <span className="text-muted-foreground">
                {" "}
                · {row.original.auth_cipher.toUpperCase()}
              </span>
            )}
          </span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Auth",
          get: (r: T) => r.auth_type,
          formatValue: (v) => ({ label: v || "—" }),
        },
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
