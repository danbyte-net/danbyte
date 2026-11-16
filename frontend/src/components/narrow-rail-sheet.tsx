import { useState } from "react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

/** A left rail for a window too narrow to show it: `content` gets a
 * `close` for a pick that should shut the sheet. */
export interface NarrowRail {
  label: string
  icon?: ReactNode
  content: (close: () => void) => ReactNode
}

/** The button (below `lg` only) that opens a rail in a sheet from the left -
 * a list page's header and a prefix page's table tabs. */
export function NarrowRailSheet({
  rail,
  className,
}: {
  rail: NarrowRail
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn("lg:hidden", className)}
        >
          {rail.icon} {rail.label}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="w-80 gap-0 overflow-hidden p-0"
      >
        <SheetTitle className="sr-only">{rail.label}</SheetTitle>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {rail.content(() => setOpen(false))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
