import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

// The figure's colour carries meaning only. The monitoring names (up, down,
// stale, skipped, flapping) and the plain ones (success, danger, warning,
// muted) share the same few colours.
const TONE = {
  up: "text-emerald-600 dark:text-emerald-400",
  success: "text-emerald-600 dark:text-emerald-400",
  down: "text-red-600 dark:text-red-400",
  danger: "text-red-600 dark:text-red-400",
  stale: "text-red-700 dark:text-red-400",
  flapping: "text-amber-600 dark:text-amber-400",
  warning: "text-amber-600 dark:text-amber-400",
  skipped: "text-muted-foreground",
  muted: "text-muted-foreground",
} as const

export type KpiTone = keyof typeof TONE

/**
 * One figure on a dashboard's top row - the Monitoring and Compliance
 * overviews. With `onClick` the whole card is a button that applies the
 * filter the figure counts; `active` marks the one applied.
 */
export function Kpi({
  label,
  value,
  tone,
  badge,
  unit,
  onClick,
  active,
}: {
  label: string
  value: number
  tone?: KpiTone
  /** "alert" reads "needs attention" in red; any other text is a plain chip. */
  badge?: string
  /** Rendered after the figure, muted - "%" on an availability. */
  unit?: string
  onClick?: () => void
  active?: boolean
}) {
  const card = (
    <Card
      size="sm"
      className={cn(
        "h-full",
        onClick && "transition-colors group-hover/kpi:bg-muted/40",
        active && "ring-2 ring-ring"
      )}
    >
      <CardHeader>
        <CardDescription className="truncate">{label}</CardDescription>
        <CardTitle
          className={cn(
            "text-2xl font-semibold tabular-nums",
            tone && TONE[tone]
          )}
        >
          {value.toLocaleString()}
          {unit && (
            <span className="ml-0.5 text-base font-normal text-muted-foreground">
              {unit}
            </span>
          )}
        </CardTitle>
        {badge && (
          <CardAction>
            <Badge
              variant={
                badge === "alert"
                  ? "destructive"
                  : tone === "up" || tone === "success"
                    ? "success"
                    : "secondary"
              }
            >
              {badge === "alert" ? "needs attention" : badge}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
    </Card>
  )
  if (!onClick) return card
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="group/kpi rounded-lg text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {card}
    </button>
  )
}
