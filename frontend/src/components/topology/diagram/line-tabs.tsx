import {
  CornerDownRight,
  FlipVertical2,
  Minus,
  Rainbow,
  Spline,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { TopologyLinkOverride } from "@/lib/api"
import type { DiagramLinkRef, LineType } from "./types"

// The Diagram's line types as a row of icon tabs, each named by its
// tooltip: the view's line in the Display popover, a link's own in its
// panel (with a first "Default" tab that follows the view, and a flip for
// an arc).

export const LINE_LOOKS: readonly {
  value: LineType
  label: string
  icon: LucideIcon
}[] = [
  { value: "straight", label: "Straight", icon: Minus },
  { value: "elbow", label: "Elbow", icon: CornerDownRight },
  { value: "bendy", label: "Bendy", icon: Spline },
  { value: "cyclical", label: "Cyclical", icon: Rainbow },
]

/** A tab's content that names it on hover: the whole tab is the trigger. */
function Named({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="-mx-3 inline-flex h-8 items-center px-3">
          <Icon className="h-4 w-4" aria-hidden />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The line types; with `inherit`, a first "Default" tab (the link
 * follows the view's line). */
export function LineTabs<TValue extends LineType | "default">({
  value,
  onChange,
  inherit = false,
}: {
  value: TValue
  onChange: (value: TValue) => void
  inherit?: boolean
}) {
  const items = [
    ...(inherit ? [{ value: "default" as TValue, label: "Default" }] : []),
    ...LINE_LOOKS.map((l) => ({
      value: l.value as TValue,
      label: <Named label={l.label} icon={l.icon} />,
    })),
  ]
  return (
    <SegmentedTabs<TValue>
      value={value}
      onValueChange={onChange}
      items={items}
    />
  )
}

/** Turn a cyclical arc over to the other side of its cards. */
export function FlipArc({ onFlip }: { onFlip: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onFlip}
          aria-label="Flip the arc"
        >
          <FlipVertical2 className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="default">Flip the arc</TooltipContent>
    </Tooltip>
  )
}

/** A link override as the view stores it: only what it sets; null when
 * it sets nothing (the link follows the view again). */
export function linkOverride(
  value: TopologyLinkOverride
): TopologyLinkOverride | null {
  const next: TopologyLinkOverride = {
    ...(value.line ? { line: value.line } : {}),
    ...(value.flip === 1 || value.flip === -1 ? { flip: value.flip } : {}),
  }
  return next.line || next.flip ? next : null
}

/** A Diagram link's own line in the view - or the view's (Default) - and
 * the side a cyclical arc bulges to. */
export function LinkLineRow({
  link,
  override,
  viewLine,
  onChange,
}: {
  link: DiagramLinkRef
  override: TopologyLinkOverride | undefined
  viewLine: LineType
  onChange: (value: TopologyLinkOverride) => void
}) {
  const line = override?.line ?? viewLine
  // The view's Cyclical arcs only the links it has to; the link's own
  // always does.
  const arced =
    line === "cyclical" && (!!link.arc || override?.line === "cyclical")
  const side = override?.flip ?? link.arc ?? -1
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Line
      </div>
      <div className="flex items-center gap-1">
        <LineTabs<LineType | "default">
          inherit
          value={override?.line ?? "default"}
          onChange={(v) =>
            onChange({ ...override, line: v === "default" ? undefined : v })
          }
        />
        {arced && (
          <FlipArc
            onFlip={() => onChange({ ...override, flip: side > 0 ? -1 : 1 })}
          />
        )}
      </div>
    </div>
  )
}
