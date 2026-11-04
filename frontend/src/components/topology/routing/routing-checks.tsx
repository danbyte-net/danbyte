import { useState } from "react"
import { ShieldAlert } from "lucide-react"

import type { RoutingCheck } from "@/lib/api"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { CHECK_LABELS } from "./routing-model"

// The Checks chip over the Routing tab (off by default, Display ▸ Checks):
// what looks wrong on the lines drawn - a session defined on one side
// only, an AS, area or level mismatch, OSPF timers or MTU that differ.
// Read-only: each item picks its line on the map.

export function RoutingChecksChip({
  checks,
  onPick,
}: {
  /** The items on the lines shown. */
  checks: readonly RoutingCheck[]
  onPick: (check: RoutingCheck) => void
}) {
  const [open, setOpen] = useState(false)
  const n = checks.length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs hover:bg-accent"
        >
          <ShieldAlert className="size-3.5 text-muted-foreground" />
          <span>Checks</span>
          <Badge variant={n ? "warning" : "success"}>{n}</Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-(--radix-popover-content-available-height) w-80 overflow-y-auto p-1"
      >
        {n === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            Nothing found
          </p>
        ) : (
          <ul>
            {checks.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    onPick(c)
                    setOpen(false)
                  }}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium">
                      {c.title}
                    </span>
                    <Badge variant="warning" className="ml-auto shrink-0">
                      {CHECK_LABELS[c.kind]}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{c.text}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
