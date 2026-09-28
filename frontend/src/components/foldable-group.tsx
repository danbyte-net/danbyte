import { useState } from "react"
import { ChevronDown, Eye, EyeOff } from "lucide-react"

import type { CheckStatus } from "@/lib/api"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import {
  statusColor,
  statusLabel,
  statusTextColor,
  useStatusLabels,
} from "@/components/monitoring/status-palette"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * A foldable list group - header with the group's name (or its ColorBadge),
 * count and a chevron that rotates -90 when closed. Every Maps page's Objects
 * sidebar (topology, site map, floor plan) folds with this, so the three read
 * the same.
 */
function readFold(storageId: string, name: string): boolean | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(storageId)!)[name]
    return typeof v === "boolean" ? v : undefined
  } catch {
    return undefined
  }
}

function writeFold(storageId: string, name: string, open: boolean) {
  let map: Record<string, boolean> = {}
  try {
    map = JSON.parse(localStorage.getItem(storageId)!) ?? {}
  } catch {
    /* first write */
  }
  map[name] = open
  try {
    localStorage.setItem(storageId, JSON.stringify(map))
  } catch {
    /* private mode - the fold just doesn't stick */
  }
}

/** Show/hide this group's objects on the map. Separate from folding: folding
 * tidies the list, this one takes the pins off the map. */
export interface GroupVisibility {
  shown: boolean
  onChange: (shown: boolean) => void
  /** The group or object's name, for the tooltip: "Hide {what}". */
  what: string
}

/** The eye button both the group headers and the object rows use, so hiding
 * a role and hiding one device look and behave the same. */
export function VisibilityToggle({ vis }: { vis: GroupVisibility }) {
  const Icon = vis.shown ? Eye : EyeOff
  const label = `${vis.shown ? "Hide" : "Show"} ${vis.what}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          // Inside a <button> header, so it cannot be a nested button - and
          // the click must not reach the fold underneath.
          onClick={(e) => {
            e.stopPropagation()
            vis.onChange(!vis.shown)
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            e.stopPropagation()
            vis.onChange(!vis.shown)
          }}
          aria-label={label}
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded",
            vis.shown
              ? "text-muted-foreground/60 hover:text-foreground"
              : "text-foreground"
          )}
        >
          <Icon className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
}

export function FoldableGroup({
  name,
  label,
  count,
  extra,
  visibility,
  defaultOpen = true,
  storageId,
  children,
}: {
  /** The group's name: drawn when there is no `label`, and the key its fold
   * state is stored under. */
  name: string
  /** Drawn in place of the name: the group's ColorBadge for a colored
   * catalog object (never a swatch beside its name). */
  label?: React.ReactNode
  count: number
  /** Trailing header content before the count - e.g. health count badges,
   * visible even when the group is folded. */
  extra?: React.ReactNode
  /** Adds the eye toggle to the header. Omit for a group that is only a list. */
  visibility?: GroupVisibility
  defaultOpen?: boolean
  /** localStorage key of a {name: open} map; set it and the fold survives
   * the visit (per browser, like the other sidebar prefs). */
  storageId?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(
    () => (storageId ? readFold(storageId, name) : undefined) ?? defaultOpen
  )
  const toggle = () =>
    setOpen((v) => {
      if (storageId) writeFold(storageId, name, !v)
      return !v
    })
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px] font-medium hover:bg-muted/60"
      >
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90"
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate",
            visibility &&
              !visibility.shown &&
              (label ? "opacity-60" : "text-muted-foreground/60")
          )}
        >
          {label ?? name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {visibility && <VisibilityToggle vis={visibility} />}
          {extra}
          <span className="num text-[11px] text-muted-foreground/70">
            {count}
          </span>
        </span>
      </button>
      {open && <div className="mb-1 flex flex-col">{children}</div>}
    </div>
  )
}

/** A check state from the API (a plain string) as the badge's union: a state
 * Danbyte does not ship reads as Unknown, as CheckStatusBadge draws it. */
function asStatus(check: string): CheckStatus {
  return check as CheckStatus
}

/** An object's monitoring state in a sidebar row: the CheckStatusBadge pill
 * (the tenant's name and color for the state) at list-row scale. */
export function RowCheckBadge({ check }: { check: string | null | undefined }) {
  if (!check) return null
  return (
    <CheckStatusBadge
      status={asStatus(check)}
      className="h-4 shrink-0 px-1.5 text-[10px]"
    />
  )
}

/** How many of a group's objects are in one state, for a group header: the
 * count on the state's own pill color, the state's name on hover. */
export function CheckCountBadge({ check, n }: { check: string; n: number }) {
  const labels = useStatusLabels()
  if (n === 0) return null
  const s = asStatus(check)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="num inline-flex h-4 shrink-0 items-center rounded-[5px] px-1 text-[10px] font-medium ring-1 ring-black/10 ring-inset dark:ring-white/10"
          style={{
            backgroundColor: statusColor(s, labels),
            color: statusTextColor(s, labels),
          }}
        >
          {n}
        </span>
      </TooltipTrigger>
      <TooltipContent variant="default">
        {statusLabel(s, labels)}
      </TooltipContent>
    </Tooltip>
  )
}
