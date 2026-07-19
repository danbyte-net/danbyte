import { Link, type LinkProps } from "@tanstack/react-router"
import { Pencil, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Inline row action buttons for DataTable "actions" columns — replaces the
 * per-row "…" dropdown with always-visible, subtle icon buttons (the row's
 * name is the Open link, so we only surface Edit + Delete here, plus any
 * `extra` actions a page needs). Right-aligned to sit at the table's edge.
 */
export function RowActions({
  editTo,
  editParams,
  onEdit,
  onDelete,
  deleteLabel = "Delete",
  extra,
}: {
  /** Edit route (e.g. "/manufacturers/$id/edit") + its params. */
  editTo?: LinkProps["to"]
  editParams?: Record<string, string>
  /** Dialog-based editors: click handler instead of an edit route. */
  onEdit?: () => void
  onDelete?: () => void
  deleteLabel?: string
  /** Page-specific buttons rendered before Edit (already icon-sized). */
  extra?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-end gap-0.5">
      {extra}
      {onEdit && !editTo && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title="Edit"
          onClick={onEdit}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="sr-only">Edit</span>
        </Button>
      )}
      {editTo && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          title="Edit"
          asChild
        >
          <Link to={editTo} params={editParams}>
            <Pencil className="h-3.5 w-3.5" />
            <span className="sr-only">Edit</span>
          </Link>
        </Button>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          title={deleteLabel}
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="sr-only">{deleteLabel}</span>
        </Button>
      )}
    </div>
  )
}
