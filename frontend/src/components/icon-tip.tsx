import type { ReactElement } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Names an icon-only button and shows the same word on hover (#461): the
 * trigger hands `label` to the button as its aria-label, so the name a screen
 * reader announces and the tooltip a pointer sees can't drift apart. The
 * row-level twin of the maps' BarIconButton, with the same one-line chip.
 */
export function IconTip({
  label,
  side = "top",
  children,
}: {
  label: string
  side?: "top" | "right" | "bottom" | "left"
  children: ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-label={label}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} variant="default">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
