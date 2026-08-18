import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Last-sync state for a connection/source. A failed badge reveals the sync
 * error in the app tooltip (panel variant — errors are multi-line prose, and
 * the native `title` bubble is unstyled and truncates). */
export function SyncStatusBadge({
  status,
  error,
}: {
  status: string
  error?: string
}) {
  if (!status)
    return <span className="text-xs text-muted-foreground">never synced</span>
  if (status === "ok")
    return (
      <Badge variant="success" className="text-[10px]">
        ok
      </Badge>
    )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="destructive" className="text-[10px]">
          failed
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel" className="max-w-96">
        <span className="font-mono text-[11px] break-words whitespace-pre-wrap">
          {error || "No error detail recorded."}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
