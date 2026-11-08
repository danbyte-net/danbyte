import type { ColumnDef } from "@tanstack/react-table"

import type { LabelTemplate } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of label templates" -
// /label-templates builds here. Templates edit in a dialog, so the name
// opens it through `onOpen` rather than a link.

export type LabelTemplateColumnId =
  "name" | "object_type" | "size" | "qr" | "default" | "updated"

const CANONICAL_ORDER: LabelTemplateColumnId[] = [
  "name",
  "object_type",
  "size",
  "qr",
  "default",
  "updated",
]

export interface LabelTemplateColumnOpts<
  T extends LabelTemplate = LabelTemplate,
> {
  omit?: LabelTemplateColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** The name opens the template's editor. */
  onOpen?: (row: T) => void
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildLabelTemplateColumns<
  T extends LabelTemplate = LabelTemplate,
>(opts: LabelTemplateColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const onOpen = opts.onOpen

  const byId: Record<LabelTemplateColumnId, () => ColumnDef<T, unknown>> = {
    name: () => ({
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) =>
        onOpen ? (
          <button
            type="button"
            className="link font-medium"
            onClick={() => onOpen(row.original)}
          >
            {row.original.name}
          </button>
        ) : (
          <span className="font-medium">{row.original.name}</span>
        ),
    }),
    object_type: () => ({
      id: "object_type",
      header: "Object type",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.object_type_label}
        </span>
      ),
    }),
    size: () => ({
      id: "size",
      header: "Size",
      cell: ({ row }) => (
        <span className="num text-muted-foreground">
          {row.original.width_mm}×{row.original.height_mm} mm
        </span>
      ),
    }),
    qr: () => ({
      id: "qr",
      header: "QR",
      cell: ({ row }) =>
        row.original.qr_enabled ? (
          <Badge variant="secondary">On</Badge>
        ) : (
          <Badge variant="outline">Off</Badge>
        ),
    }),
    default: () => ({
      id: "default",
      header: "Default",
      cell: ({ row }) =>
        row.original.is_default ? (
          <Badge variant="secondary">Default</Badge>
        ) : null,
    }),
    updated: () => ({
      id: "updated",
      header: "Updated",
      cell: ({ row }) => <TimeCell iso={row.original.updated_at} />,
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
