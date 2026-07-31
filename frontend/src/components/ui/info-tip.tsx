import { type ReactNode } from "react"
import { Info } from "lucide-react"

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

/**
 * A small (i) icon that reveals an explanation on hover/focus. Use this instead
 * of cramming a clarifying parenthetical into a label or select option — those
 * read as noise across a settings page. Keep the label clean; put the "why" here.
 */
export function InfoTip({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <HoverCard openDelay={100} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label="More information"
          className={`inline-flex items-center text-muted-foreground/70 transition-colors hover:text-foreground ${className ?? ""}`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-xs leading-relaxed text-muted-foreground">
        {children}
      </HoverCardContent>
    </HoverCard>
  )
}
