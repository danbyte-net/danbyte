import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TruncatedText } from "@/components/ui/truncated-text"
import { cn } from "@/lib/utils"

// The detail panel a map opens over its canvas when something on it is
// clicked: a title with a Close button, key/value rows, labelled sections,
// and the actions at the foot ("Open device" first, then anything that stays
// on the map, such as "Focus"). One layout, so a device, a cable, a bundle or
// a group reads the same way.

/** A section heading inside a side panel, legend or popover: "Ports",
 * "Line", "Roles". */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "mb-1 text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </div>
  )
}

/** A labelled part of a panel's body, under a rule. */
export function PanelSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section
      aria-label={label}
      className="mt-2 border-t border-border pt-2 first:mt-0 first:border-t-0 first:pt-0"
    >
      <SectionLabel>{label}</SectionLabel>
      {children}
    </section>
  )
}

/** One key/value row: a muted label and its value. A long value wraps rather
 * than being clipped. */
export function PanelRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 text-right text-[12px] [overflow-wrap:anywhere]">
        {children}
      </span>
    </div>
  )
}

export function PanelShell({
  label,
  title,
  titleText,
  onClose,
  footer,
  children,
}: {
  /** What the panel is ("Device", "Cable"), for screen readers. */
  label: string
  title: React.ReactNode
  /** The title in full, for the hover when it is clipped - needed when
   * `title` is not a plain string. */
  titleText?: string
  onClose: () => void
  /** Actions: "Open X" first, then those that stay on the map. */
  footer?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <aside
      aria-label={label}
      className="absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-80 flex-col rounded-lg border border-border bg-background/95"
    >
      <div className="flex items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
        <TruncatedText
          className="flex-1 text-sm font-semibold"
          title={titleText}
        >
          {title}
        </TruncatedText>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close"
              onClick={onClose}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" variant="default">
            Close
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 overflow-auto p-3 text-[12px]">{children}</div>
      {footer && (
        <div className="flex gap-2 border-t border-border px-3 py-2 [&>*]:flex-1">
          {footer}
        </div>
      )}
    </aside>
  )
}
