import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Last-sync state for a connection/source.
 *
 * A failed badge reveals the sync error in the app tooltip (panel variant -
 * errors are multi-line prose, and the native `title` bubble is unstyled and
 * truncates).
 *
 * A run that succeeded but couldn't record everything reads as `ok · N
 * skipped`. Those are not errors and not drift - the sync worked, it just saw
 * things it had nowhere to put (an address with no prefix, a host with no
 * matching site). The full list lives on the source's detail page; the tooltip
 * shows the first few. */
export function SyncStatusBadge({
  status,
  error,
  skipped,
}: {
  status: string
  error?: string
  skipped?: string[]
}) {
  if (!status)
    return <span className="text-xs text-muted-foreground">never synced</span>

  const failed = status !== "ok"
  const notes = failed ? [error || "No error detail recorded."] : skipped ?? []
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
            : `ok · ${notes.length} skipped`}
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel" className="max-w-96">
        <span className="font-mono text-[11px] break-words whitespace-pre-wrap">
          {notes.slice(0, 6).join("\n")}
          {notes.length > 6 && `\n… ${notes.length - 6} more - open the source`}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
