import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { DeviceType } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { LocalityBadge } from "@/components/locality-badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { lifecycleColumn } from "@/components/cells/lifecycle-cell"
import { manufacturerColumn } from "@/components/cells/manufacturer-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of device types". Every surface that
// lists device types — /device-types, the embedded table on a manufacturer's
// detail page, the monitoring configuration tab — builds its columns here so a
// device-type row reads identically everywhere. Page-specific columns (the
// monitoring binding control) are spliced around this factory's output; the
// shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type DeviceTypeColumnId =
  | "numid"
  | "name"
  | "manufacturer"
  | "model"
  | "part_number"
  | "u_height"
  | "images"
  | "faceplate"
  | "devices"
  | "lifecycle"
  | "description"
  | "scope"
  | "tags"
  | "updated"

const CANONICAL_ORDER: DeviceTypeColumnId[] = [
  "numid",
  "name",
  "manufacturer",
  "model",
  "part_number",
  "u_height",
  "images",
  "faceplate",
  "devices",
  "lifecycle",
  "description",
  "scope",
  "tags",
  "updated",
]

/** Which rack-face photos the type carries, in face order. */
function imageFaces(d: DeviceType): string[] {
  const faces: string[] = []
  if (d.front_image) faces.push("Front")
  if (d.rear_image) faces.push("Rear")
  return faces
}

type PanelLayout = "photo" | "custom" | "auto"

const PANEL_LABELS: Record<PanelLayout, string> = {
  photo: "Photo ports",
  custom: "Custom",
  auto: "Auto",
}

/** What a device of this type draws as its panel — one value, because the panel
 * itself picks one (`useHasImagePorts`): photo markers win, but only when there
 * is a photo under them; otherwise a saved faceplate layout; otherwise the
 * automatic one. So "Auto" is the not-yet-laid-out queue. */
function panelLayout(d: DeviceType): PanelLayout {
  const ports = d.image_ports
  const placed = !!ports && (ports.front.length > 0 || ports.rear.length > 0)
  if (placed && (d.front_image || d.rear_image)) return "photo"
  return d.faceplate ? "custom" : "auto"
}

export interface DeviceTypeColumnOpts<T extends DeviceType = DeviceType> {
  /** Drop columns. */
  omit?: DeviceTypeColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: DeviceTypeColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Header for the rack-units column: "U" where the row is dense, "Height"
   * where the embedded table has room to spell it out. */
  heightHeader?: string
  /** Facet treatment for the Devices count. The list page filters on the
   * in-use / unused split (the question a long catalog asks: which entries is
   * nothing built from?); the monitoring configuration tab filters by numeric
   * range. Same knob, same meaning, as `buildDeviceRoleColumns`. */
  countFacets?: "usage" | "range"
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildDeviceTypeColumns<T extends DeviceType = DeviceType>(
  opts: DeviceTypeColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: DeviceTypeColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))
  const ranges = opts.countFacets === "range"

  const byId: Record<DeviceTypeColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/device-types/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          <PlannedChangeMarker
            objectType="api.devicetype"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    manufacturer: () => manufacturerColumn<T>({ get: (r) => r.manufacturer }),
    model: () => ({
      id: "model",
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) =>
        row.original.model ? (
          <span className="font-mono text-xs">{row.original.model}</span>
        ) : (
          dash
        ),
    }),
    part_number: () => ({
      id: "part_number",
      accessorKey: "part_number",
      header: "Part number",
      cell: ({ row }) =>
        row.original.part_number ? (
          <span className="font-mono text-xs">{row.original.part_number}</span>
        ) : (
          dash
        ),
    }),
    u_height: () => ({
      id: "u_height",
      accessorKey: "u_height",
      header: ({ column }) => (
        <SortHeader column={column} label={opts.heightHeader ?? "U"} />
      ),
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.u_height}U</span>
      ),
      meta: {
        facet: {
          kind: "range",
          label: "U",
          get: (r: T) => r.u_height,
          min: 0,
          unit: "U",
        },
      },
    }),
    images: () => ({
      id: "images",
      // Which faces exist is the detail (and what exports); whether any does is
      // the filter.
      accessorFn: (r) => imageFaces(r).join(", "),
      header: "Images",
      enableSorting: false,
      cell: ({ row }) => {
        const faces = imageFaces(row.original)
        if (faces.length === 0) return dash
        return (
          <span className="flex items-center gap-1">
            {faces.map((face) => (
              <Badge
                key={face}
                variant="secondary"
                className="h-4 px-1.5 text-[10px] font-normal"
              >
                {face}
              </Badge>
            ))}
          </span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Images",
          get: (r: T) => (r.front_image || r.rear_image ? "yes" : "no"),
          formatValue: (v) => ({ label: v === "yes" ? "Yes" : "No" }),
        },
      },
    }),
    faceplate: () => ({
      id: "faceplate",
      accessorFn: (r) => PANEL_LABELS[panelLayout(r)],
      header: "Faceplate",
      enableSorting: false,
      cell: ({ row }) => {
        const layout = panelLayout(row.original)
        return (
          <span
            className={
              layout === "auto" ? "text-xs text-muted-foreground" : "text-xs"
            }
          >
            {PANEL_LABELS[layout]}
          </span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Faceplate",
          get: (r: T) => panelLayout(r),
          formatValue: (v) => ({ label: PANEL_LABELS[v as PanelLayout] }),
          // Nothing laid out yet (or everything) — the split is the only
          // reason this facet is interesting.
          hideWhenSingle: true,
        },
      },
    }),
    devices: () => ({
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
      meta: ranges
        ? {
            facet: {
              kind: "range",
              label: "Devices",
              get: (r: T) => r.device_count,
              min: 0,
            },
          }
        : {
            facet: {
              kind: "enum",
              label: "Usage",
              get: (r: T) => (r.device_count > 0 ? "in" : "out"),
              formatValue: (v) => ({
                label: v === "in" ? "In use" : "Unused",
              }),
            },
          },
    }),
    lifecycle: () => lifecycleColumn<T>({ get: (r) => r }),
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
    scope: () => ({
      id: "scope",
      accessorFn: (r) => r.owning_site?.name ?? "",
      header: "Scope",
      cell: ({ row }) => (
        <LocalityBadge owningSite={row.original.owning_site} />
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Scope",
          get: (r: T) => r.owning_site?.id ?? "__global__",
          formatValue: (_v, sample) => ({
            label: sample.owning_site?.name ?? "Global",
          }),
          // Every entry is tenant-wide unless the deployment runs site-scoped
          // catalogs, and "Global (everything)" is not a filter.
          hideWhenSingle: true,
        },
      },
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
