import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { CornerDownRight } from "lucide-react"

import type {
  BulkStatusEntry,
  ComplianceViolation,
  CustomField,
  Prefix,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { dash } from "@/components/cells/dash"
import { UtilCell } from "@/components/cells/util-cell"
import { ColorBadge } from "@/components/cells/color-badge"
import { siteColumn } from "@/components/cells/site-cell"
import { vrfColumn } from "@/components/cells/vrf-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { formatCustomValue } from "@/components/custom-field-display"
import {
  actionsColumn,
  type ActionsColumnOpts,
} from "@/components/columns/actions-column"

// The one source of truth for "a table of prefixes". Every surface that
// lists prefixes — /prefixes, the VLAN/VRF/Site detail panes, the monitoring
// configuration tab — builds its columns here so a prefix row reads
// identically everywhere. Page-specific columns (e.g. monitoring engine
// bindings) are spliced around this factory's output; the shared cells are
// never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.

export type PrefixColumnId =
  | "cidr"
  | "status"
  | "monitoring"
  | "vrf"
  | "vlan"
  | "site"
  | "gateway"
  | "description"
  | "utilisation"
  | "tags"
  | "updated"

const CANONICAL_ORDER: PrefixColumnId[] = [
  "cidr",
  "status",
  "monitoring",
  "vrf",
  "vlan",
  "site",
  "gateway",
  "description",
  "utilisation",
  "tags",
  "updated",
]

export interface PrefixColumnOpts<T extends Prefix = Prefix> {
  /** Drop columns (e.g. the VRF page omits "vrf", the Site page "site"). */
  omit?: PrefixColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: PrefixColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Depth chevrons for the nested list view (rows carry `_depth`). */
  nested?: boolean
  /** Compliance violation badges on the CIDR cell. */
  violations?: Map<string, ComplianceViolation[]>
  /** Monitoring status per prefix id — enables the "Monitoring" column. */
  monitoring?: Record<string, BulkStatusEntry>
  /** One column per tenant custom field (hidden by default via Columns menu). */
  cfDefs?: CustomField[]
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Hidden VRF column so DataTable can group by "vrfName". */
  vrfGroupColumn?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** Stable facet bucket for a custom-field value (null = not counted). */
function cfFacetKey(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.map(String).join(", ")
  return String(v)
}

function monitoringTooltip(e: BulkStatusEntry): string {
  const counts = e.counts ?? {}
  const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`)
  const head = `${e.monitored_ips ?? 0} monitored IP${
    e.monitored_ips === 1 ? "" : "s"
  }`
  return parts.length ? `${head} — ${parts.join(", ")}` : head
}

export function buildPrefixColumns<T extends Prefix = Prefix>(
  opts: PrefixColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The Monitoring column only exists when the page fetched bulk status.
  if (!opts.monitoring) omit.add("monitoring")
  const keep = (id: PrefixColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<PrefixColumnId, () => ColumnDef<T, unknown>> = {
    cidr: () => ({
      id: "cidr",
      accessorKey: "cidr",
      header: ({ column }) => <SortHeader column={column} label="Prefix" />,
      cell: ({ row }) => {
        const depth = opts.nested
          ? ((row.original as Prefix & { _depth?: number })._depth ?? 0)
          : 0
        return (
          <div className="flex items-center gap-0.5">
            {/* One CornerDownRight per depth level — additive so the tree
                depth reads at a glance: /16 → /24 → /26 → /30 shows as 0,
                1, 2, 3 chevrons. */}
            {Array.from({ length: depth }, (_, i) => (
              <CornerDownRight
                key={i}
                aria-hidden
                className="h-3 w-3 shrink-0 text-muted-foreground/40"
              />
            ))}
            <Link
              to="/prefixes/$id"
              params={{ id: row.original.id }}
              className="font-mono font-medium hover:underline"
            >
              {row.original.cidr}
            </Link>
            {opts.violations && (
              <ViolationBadge
                objectId={row.original.id}
                map={opts.violations}
              />
            )}
          </div>
        )
      },
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => r.status?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.status?.name ?? "No status",
            color: sample.status?.color,
            textColor: sample.status?.text_color,
          }),
        },
      },
    }),
    monitoring: () => ({
      id: "monitoring",
      header: "Monitoring",
      enableSorting: false,
      cell: ({ row }) => {
        const e = opts.monitoring?.[row.original.id]
        if (!e || !e.status) return dash
        return (
          <span title={monitoringTooltip(e)}>
            <MixedStatusBadge counts={e.counts} status={e.status} />
          </span>
        )
      },
    }),
    vrf: () => vrfColumn<T>({ get: (p) => p.vrf }),
    vlan: () => ({
      id: "vlan",
      accessorFn: (r) => (r.vlan ? `${r.vlan.vlan_id} · ${r.vlan.name}` : ""),
      header: "VLAN",
      cell: ({ row }) => {
        const v = row.original.vlan
        return v ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">
              {v.vlan_id} · {v.name}
            </span>
            {v.zone && (
              <ColorBadge
                name={v.zone.name}
                color={v.zone.color || undefined}
              />
            )}
          </span>
        ) : (
          dash
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "VLAN",
          get: (r: T) => r.vlan?.id ?? "__none__",
          formatValue: (_v, sample) => ({
            label: sample.vlan
              ? `${sample.vlan.vlan_id} · ${sample.vlan.name}`
              : "No VLAN",
          }),
        },
      },
    }),
    site: () => siteColumn<T>({ get: (p) => p.site }),
    gateway: () => ({
      id: "gateway",
      accessorKey: "gateway",
      header: "Gateway",
      cell: ({ row }) =>
        row.original.gateway ? (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.gateway}
          </span>
        ) : (
          dash
        ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="block whitespace-nowrap text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    utilisation: () => ({
      id: "utilisation",
      accessorKey: "utilisation_pct",
      header: ({ column }) => (
        <SortHeader column={column} label="Utilisation" />
      ),
      cell: ({ row }) => <UtilCell pct={row.original.utilisation_pct} />,
      meta: {
        facet: {
          kind: "range",
          label: "Utilisation",
          get: (r: T) => r.utilisation_pct,
          min: 0,
          max: 100,
          unit: "%",
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

  // One column per tenant custom field. Values come from the prefix's
  // custom_fields blob; hide any you don't want via the Columns menu. Each
  // carries an enum facet over its observed values, so the filter rail
  // adapts to whatever custom fields the tenant defined.
  for (const d of opts.cfDefs ?? []) {
    cols.push({
      id: `cf_${d.key}`,
      header: d.label,
      enableSorting: false,
      accessorFn: (r) => r.custom_fields?.[d.key],
      cell: ({ row }) =>
        formatCustomValue(d, row.original.custom_fields?.[d.key]),
      meta: {
        facet: {
          kind: "enum",
          label: d.label,
          get: (r: T) => cfFacetKey(r.custom_fields?.[d.key]),
        },
      },
    })
  }

  if (opts.vrfGroupColumn) {
    cols.push({
      // Kept as a column so TanStack's grouping can key on it, but hidden
      // by default (see initialColumnVisibility) — the VRF group banner
      // already prints the name above each section, so repeating it on
      // every row is dead weight. User can re-show via the Columns menu.
      id: "vrfName",
      accessorFn: (r) => r.vrf?.name ?? "Global",
      header: "VRF",
      cell: ({ row }) => row.original.vrf?.name ?? "Global",
      meta: {
        facet: {
          kind: "enum",
          label: "VRF",
          get: (r: T) => r.vrf?.id ?? "__global__",
          formatValue: (_v, sample) => ({
            label: sample.vrf?.name ?? "Global",
            color: sample.vrf?.color ?? undefined,
          }),
        },
      },
    })
  }

  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
