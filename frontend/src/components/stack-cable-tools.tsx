import { createContext, useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { X } from "lucide-react"

import {
  linkEndText,
  stackCableGroups,
  stackLinkKey,
  stackLinkText,
} from "@/lib/stacks"
import type { SceneStack, StackLink, StackLinkStore } from "@/lib/stacks"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { BarMenuTrigger } from "@/components/map-toolbar"
import { RecordStackCablesDialog } from "@/components/stack-cable-dialog"
import type { RecordTarget } from "@/components/stack-cable-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * A 3D view's stack cables outside its canvas (docs/dcim/virtual-chassis.md
 * → Tracing a cable): the toolbar's **Cables** list, the picked cable's
 * card, and Record cable for derived ones. They read the view's
 * StackLinkStore (lib/stacks), which the canvas's StackCables fills. No
 * three.js here: the toolbar loads before the 3D chunk.
 */

/** A cable store a host outside the viewer made (the model viewer card's
 * toolbar), for the stack view inside to use. */
export const StackLinksContext = createContext<StackLinkStore | null>(null)

const noVersion = () => 0

/** Re-render on the store's changes. */
function useStackLinksStore(store: StackLinkStore) {
  useSyncExternalStore(store.subscribe, store.getVersion, noVersion)
}

/** A derived link as Record cable takes it. */
export function recordTarget(
  stacks: readonly SceneStack[],
  link: StackLink
): RecordTarget {
  return {
    key: stackLinkKey(link),
    line: `${linkEndText(stacks, link.a)} → ${linkEndText(stacks, link.b)}`,
    link,
  }
}

/** Whether a link can be recorded here: derived, with both port ids. */
function recordable(link: StackLink): boolean {
  return link.derived && !!link.a.id && !!link.b.id
}

/** The toolbar's **Cables**: each drawn stack cable, Stack then
 * StackPower; a row picks it, hovering previews it. **Record all** opens
 * Record cable for every derived one, for a reader who may add cables. */
export function StackCablesMenu({
  store,
  container,
}: {
  store: StackLinkStore
  /** The fullscreen frame: the menu mounts inside it. */
  container?: HTMLElement | null
}) {
  useStackLinksStore(store)
  const { canDo } = useMe()
  const groups = stackCableGroups(store.stacks)
  const derived = store.stacks.flatMap((s) => s.links.filter(recordable))
  const picked = store.selected
  if (!groups.length) return null
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) store.setPreview(null)
      }}
    >
      <DropdownMenuTrigger asChild>
        <BarMenuTrigger className={cn(!picked && "text-muted-foreground")}>
          Cables
        </BarMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-80 min-w-44 overflow-y-auto"
        container={container ?? undefined}
      >
        {groups.map((g, i) => (
          <div key={`${g.title}-${i}`}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {g.title}
            </DropdownMenuLabel>
            {g.rows.map((r) => (
              <DropdownMenuItem
                key={r.key}
                className={cn(
                  "font-mono text-xs",
                  picked === r.key && "bg-accent"
                )}
                onPointerEnter={() => store.setPreview(r.key)}
                onPointerLeave={() => store.setPreview(null)}
                onSelect={() => {
                  store.setPreview(null)
                  store.select(r.key)
                }}
              >
                <span className="flex-1">{r.line}</span>
                {r.link.derived && (
                  <span className="text-[11px] text-muted-foreground">
                    derived
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {derived.length > 0 && canDo("cable", "add") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => store.record(derived.map((l) => stackLinkKey(l)))}
            >
              Record all…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The picked cable's card, pinned in a corner of the view, and Record
 * cable's dialog. */
export function StackCableCard({
  store,
  className,
}: {
  store: StackLinkStore
  className?: string
}) {
  useStackLinksStore(store)
  const { canDo } = useMe()
  const stacks = store.stacks
  const all = stacks.flatMap((s) => s.links)
  const link = all.find((l) => stackLinkKey(l) === store.selected) ?? null
  const recording = store.recording
  const targets = recording
    ? all
        .filter((l) => recording.includes(stackLinkKey(l)) && recordable(l))
        .map((l) => recordTarget(stacks, l))
    : null
  return (
    <>
      {link && (
        <div
          className={cn(
            "pointer-events-auto absolute z-10 min-w-56 rounded-md border border-border bg-popover/95 px-3 py-2 text-xs text-popover-foreground shadow-md",
            className ?? "bottom-2 left-2"
          )}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold">
              {stackLinkText({ ...link, derived: false })}
            </span>
            <Badge variant="secondary">
              {link.derived ? "Derived" : "Recorded"}
            </Badge>
            <button
              type="button"
              aria-label="Close"
              className="ml-auto rounded-md p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => store.clear()}
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="mt-1 font-mono whitespace-nowrap">
            <div>A · {linkEndText(stacks, link.a)}</div>
            <div>B · {linkEndText(stacks, link.b)}</div>
          </div>
          {link.label && (
            <div className="mt-1 font-mono text-muted-foreground">
              {link.label}
            </div>
          )}
          {link.cable && (
            <Link
              to="/cables/$id"
              params={{ id: link.cable }}
              className="mt-1 inline-block text-primary hover:underline"
            >
              Open cable
            </Link>
          )}
          {recordable(link) && canDo("cable", "add") && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7"
              onClick={() => store.record([stackLinkKey(link)])}
            >
              Record cable…
            </Button>
          )}
        </div>
      )}
      <RecordStackCablesDialog
        targets={targets && targets.length ? targets : null}
        onClose={() => store.record(null)}
      />
    </>
  )
}
