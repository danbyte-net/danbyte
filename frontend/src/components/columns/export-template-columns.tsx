import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ExportTemplate } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of export templates" -
// /export-templates builds here.

export type ExportTemplateColumnId =
  "numid" | "name" | "object_type" | "format" | "description"

const CANONICAL_ORDER: ExportTemplateColumnId[] = [
  "numid",
  "name",
  "object_type",
  "format",
  "description",
]

export interface ExportTemplateColumnOpts<
  T extends ExportTemplate = ExportTemplate,
> {
  omit?: ExportTemplateColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildExportTemplateColumns<
  T extends ExportTemplate = ExportTemplate,
>(opts: ExportTemplateColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")

  const byId: Record<ExportTemplateColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/export-templates/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    }),
    object_type: () => ({
      id: "object_type",
      accessorKey: "object_type_label",
      header: "Object type",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.object_type_label}</span>
      ),
    }),
    format: () => ({
      id: "format",
      header: "Format",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          .{row.original.file_extension} · {row.original.mime_type}
        </span>
      ),
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
