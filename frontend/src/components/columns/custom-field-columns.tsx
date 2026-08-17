import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { Check } from "lucide-react"

import type { CustomField } from "@/lib/api"
import { fieldTypeLabel, modelLabel } from "@/lib/custom-fields"
import { Badge } from "@/components/ui/badge"
import { PlannedChangeMarker } from "@/components/planning/planned-change-badge"
import { dash } from "@/components/cells/dash"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of custom-field definitions". The
// /custom-fields list and the Fields pane on a custom-field group's detail page
// both build their columns here, so a field row reads identically in both
// places. The list previously carried its own inline ColumnDef[]; the group
// page would have made that a second copy.
//
// Facet meta (useTableFilters) is attached where it makes sense; panes that
// don't draw a facet rail simply ignore it.

export type CustomFieldColumnId =
  | "key"
  | "label"
  | "type"
  | "applies"
  | "group"
  | "required"
  | "weight"
  | "updated"

const CANONICAL_ORDER: CustomFieldColumnId[] = [
  "key",
  "label",
  "type",
  "applies",
  "group",
  "required",
  "weight",
  "updated",
]

export interface CustomFieldColumnOpts<T extends CustomField = CustomField> {
  /** Drop columns (e.g. a group's own page omits "group"). */
  omit?: CustomFieldColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CustomFieldColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildCustomFieldColumns<T extends CustomField = CustomField>(
  opts: CustomFieldColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: CustomFieldColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CustomFieldColumnId, () => ColumnDef<T, unknown>> = {
    key: () => ({
      id: "key",
      accessorKey: "key",
      header: ({ column }) => <SortHeader column={column} label="Key" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/custom-fields/$id"
            params={{ id: row.original.id }}
            className="link font-mono font-medium"
          >
            {row.original.key}
          </Link>
          <PlannedChangeMarker
            objectType="customization.customfield"
            objectId={row.original.id}
          />
        </span>
      ),
    }),
    label: () => ({
      id: "label",
      accessorKey: "label",
      header: "Label",
      cell: ({ row }) => (
        <span className="line-clamp-1 block">{row.original.label}</span>
      ),
    }),
    type: () => ({
      id: "type",
      accessorKey: "type",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <Badge variant="secondary">{fieldTypeLabel(row.original.type)}</Badge>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: T) => r.type,
          formatValue: (_v, sample) => ({ label: fieldTypeLabel(sample.type) }),
        },
      },
    }),
    applies: () => ({
      id: "applies",
      header: "Applies to",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.applies_to.length ? (
          <span className="text-xs text-muted-foreground">
            {row.original.applies_to.map(modelLabel).join(" · ")}
          </span>
        ) : (
          dash
        ),
    }),
    group: () => ({
      id: "group",
      accessorFn: (f) => f.group_name ?? "",
      header: "Group",
      // group_name rides along on the field read, so the section a field sits
      // in never costs a second fetch.
      cell: ({ row }) =>
        row.original.group && row.original.group_name ? (
          <Link
            to="/custom-field-groups/$id"
            params={{ id: row.original.group }}
            className="link text-xs"
          >
            {row.original.group_name}
          </Link>
        ) : (
          dash
        ),
    }),
    required: () => ({
      id: "required",
      accessorKey: "required",
      header: "Required",
      cell: ({ row }) =>
        row.original.required ? (
          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          dash
        ),
    }),
    weight: () => ({
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
      ),
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
