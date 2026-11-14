import { CalendarPlus } from "lucide-react"
import type { Server } from "lucide-react"

import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { LEVELS, levelTone } from "@/components/monitoring/impact-levels"

/**
 * The shared parts of an "affected" answer: what a power or cooling source
 * (#434) or a failing device (#450) takes down with it. A header with **Plan
 * maintenance**, then sections of rows, each object linked with how hard
 * the work hits it (Outage, Reduced redundancy).
 */

export function AffectedLevel({ level }: { level: string }) {
  return (
    <span className={`shrink-0 text-[11px] ${levelTone[level] ?? ""}`}>
      {LEVELS.find((l) => l.value === level)?.label ?? level}
    </span>
  )
}

export function AffectedRow({
  icon: Icon,
  name,
  link,
  note,
  level,
}: {
  icon: typeof Server
  name: string
  link: React.ReactNode
  note?: string
  level?: string
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2" data-row={name}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        {link}
        {note && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {note}
          </span>
        )}
      </div>
      {level && <AffectedLevel level={level} />}
    </div>
  )
}

export const affectedLinkCls = "link block truncate text-[13px] font-medium"

export function AffectedSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase">
        {title}
        <span className="num ml-1.5 font-normal">{count}</span>
      </h3>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {children}
      </div>
    </section>
  )
}

/** The line above the sections: what the answer is about, and **Plan
 * maintenance** for a caller who may add events. */
export function AffectedHeader({
  text,
  onPlan,
}: {
  text: React.ReactNode
  onPlan: () => void
}) {
  const { canDo } = useMe()
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="truncate text-sm text-muted-foreground">{text}</p>
      {canDo("maintenanceevent", "add") && (
        <Button size="sm" variant="outline" onClick={onPlan}>
          <CalendarPlus className="h-3.5 w-3.5" /> Plan maintenance
        </Button>
      )}
    </div>
  )
}
