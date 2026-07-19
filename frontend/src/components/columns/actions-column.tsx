import { type ColumnDef } from "@tanstack/react-table"
import { type LinkProps } from "@tanstack/react-router"

import { RowActions } from "@/components/row-actions"

// Canonical trailing "actions" column. Every table's row actions go through
// here (and RowActions) so Edit/Delete affordances look and gate identically
// everywhere — never hand-roll an actions cell or a per-row "…" dropdown.
//
//   actionsColumn<Prefix>({
//     editTo: "/prefixes/$id/edit",
//     editParams: (p) => ({ id: p.id }),
//     canEdit: (p) => objCan(p, "change", canEdit),
//     onDelete: setDeleting,
//     canDelete: (p) => objCan(p, "delete", canDelete),
//   })
export interface ActionsColumnOpts<T> {
  /** Edit route (e.g. "/prefixes/$id/edit") + its params. */
  editTo?: LinkProps["to"]
  editParams?: (row: T) => Record<string, string>
  /** Dialog-based editors: pencil button with a click handler instead of a link. */
  onEdit?: (row: T) => void
  onDelete?: (row: T) => void
  deleteLabel?: string
  /** Per-row RBAC gates — when they return false the button is not rendered. */
  canEdit?: (row: T) => boolean
  canDelete?: (row: T) => boolean
  /** Page-specific buttons rendered before Edit (already icon-sized). */
  extra?: (row: T) => React.ReactNode
}

export function actionsColumn<T>(
  opts: ActionsColumnOpts<T>
): ColumnDef<T, unknown> {
  return {
    id: "actions",
    enableHiding: false,
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original
      const allowEdit = opts.canEdit ? opts.canEdit(r) : true
      const allowDelete = opts.canDelete ? opts.canDelete(r) : true
      return (
        <RowActions
          editTo={allowEdit ? opts.editTo : undefined}
          editParams={opts.editParams?.(r)}
          onEdit={allowEdit && opts.onEdit ? () => opts.onEdit!(r) : undefined}
          onDelete={
            allowDelete && opts.onDelete ? () => opts.onDelete!(r) : undefined
          }
          deleteLabel={opts.deleteLabel}
          extra={opts.extra?.(r)}
        />
      )
    },
  }
}
