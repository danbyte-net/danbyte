import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Last-sync state for a connection/source.
 *
 * A failed badge reveals the sync error in the app tooltip (panel variant —
 * errors are multi-line prose, and the native `title` bubble is unstyled and
 * truncates). A run that succeeded but couldn't place every address reads as
 * `ok · N warnings` with the same treatment: a scheduled sync has no toast to
 * show, so this badge is the only place those notes surface. */
export function SyncStatusBadge({
  status,
  error,
  warnings,
}: {
  status: string
  error?: string
  warnings?: string[]
}) {
  if (!status)
    return <span className="text-xs text-muted-foreground">never synced</span>

  const failed = status !== "ok"
  const notes = failed ? [error || "No error detail recorded."] : warnings ?? []
  if (!failed && notes.length === 0)
    return (
      <Badge variant="success" className="text-[10px]">
        ok
      </Badge>
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={failed ? "destructive" : "warning"}
          className="text-[10px]"
        >
          {failed
            ? "failed"
            : `ok · ${notes.length} warning${notes.length === 1 ? "" : "s"}`}
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel" className="max-w-96">
        <span className="font-mono text-[11px] break-words whitespace-pre-wrap">
          {notes.join("\n")}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
