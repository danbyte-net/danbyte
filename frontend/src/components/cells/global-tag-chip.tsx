import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// Marks a deployment-global tag (no tenant - every tenant sees it) beside
// its name, so it stays distinguishable from a tenant tag spelled the same.
export function GlobalTagChip({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "h-4 px-1 text-[10px] font-normal text-muted-foreground",
            className
          )}
        >
          global
        </Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">Shared by all tenants</TooltipContent>
    </Tooltip>
  )
}
