import type { ReactNode } from "react"
import { EyeOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * An address excluded from monitoring: every check parked, nothing counted.
 * The same squarish badge wherever it shows - the IP's tab and summary, a
 * prefix's address rows, the checks list. `detail` (who and when) opens on
 * hover where there is room to say it.
 */
export function ExcludedPill({ detail }: { detail?: ReactNode }) {
  const pill = (
    <Badge variant="secondary" className="gap-1">
      <EyeOff className="h-3 w-3" />
      Excluded
    </Badge>
  )
  if (!detail) return pill
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{pill}</span>
      </TooltipTrigger>
      <TooltipContent variant="panel">{detail}</TooltipContent>
    </Tooltip>
  )
}
