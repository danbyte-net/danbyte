import { useEffect, useMemo, useRef, useState } from "react"

import type { FloorPlanCablePath } from "@/lib/api"
import { PointerMenu } from "@/components/pointer-menu"
import type { PointerMenuAt } from "@/components/pointer-menu"
import { StatusBadge } from "@/components/status-badge"
import { Input } from "@/components/ui/input"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

import {
  CABLE_NONE,
  cableChoices,
  filterChoices,
  typePalette,
} from "./cable-draw"
import type { CableColorBy } from "./cable-draw"

/** Past this many cables the chooser gets a search box. */
export const CHOOSER_SEARCH_FROM = 8

/** An open chooser: where (client px), which cables, and what holds them. */
export interface CableChooserAt extends PointerMenuAt {
  ids: string[]
  /** What was clicked, e.g. a tray's name; else "N cables". */
  title?: string
  /** List in the order given (a click's: nearest first), not lane order. */
  ordered?: boolean
}

/**
 * Which cable? A click where several cables meet (a bundle, a fan of
 * stubs, lanes over each other) or on a tray that carries several opens
 * this at the pointer: each cable once with its colour, label, both ends
 * and status - nearest first for a click, in lane order for a tray - and a
 * search box when there are many. The row under the pointer (or the keyboard) shows that cable
 * alone on the plan (`onPreview`); a pick traces it and opens its panel
 * (`onPick`). Arrows, Enter and Esc work as in any menu.
 */
export function CableChooser({
  menu,
  cablePaths,
  colorBy,
  onClose,
  onPreview,
  onPick,
}: {
  menu: CableChooserAt | null
  cablePaths: readonly FloorPlanCablePath[]
  colorBy: CableColorBy
  onClose: () => void
  onPreview: (id: string | null) => void
  onPick: (id: string) => void
}) {
  return (
    <PointerMenu
      menu={menu}
      onClose={() => {
        onPreview(null)
        onClose()
      }}
      label="Choose a cable"
      className="w-96 p-0"
    >
      {(m) => (
        <ChooserBody
          key={`${m.x},${m.y},${m.ids.join(",")}`}
          menu={m}
          cablePaths={cablePaths}
          colorBy={colorBy}
          onPreview={onPreview}
          onPick={onPick}
        />
      )}
    </PointerMenu>
  )
}

function ChooserBody({
  menu,
  cablePaths,
  colorBy,
  onPreview,
  onPick,
}: {
  menu: CableChooserAt
  cablePaths: readonly FloorPlanCablePath[]
  colorBy: CableColorBy
  onPreview: (id: string | null) => void
  onPick: (id: string) => void
}) {
  const rows = useMemo(
    () =>
      cableChoices(menu.ids, cablePaths, colorBy, typePalette(cablePaths), {
        keepOrder: menu.ordered,
      }),
    [menu.ids, menu.ordered, cablePaths, colorBy]
  )
  const [query, setQuery] = useState("")
  const shown = useMemo(() => filterChoices(rows, query), [rows, query])
  const searchable = rows.length > CHOOSER_SEARCH_FROM
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!searchable) return
    // After the menu takes the focus on open.
    const id = window.setTimeout(() => search.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [searchable])

  return (
    <>
      <DropdownMenuLabel className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate">
          {menu.title ?? `${rows.length} cables`}
        </span>
        {menu.title && (
          <span className="num shrink-0 text-xs font-normal text-muted-foreground">
            {rows.length}
          </span>
        )}
      </DropdownMenuLabel>
      {searchable && (
        <div className="px-2 pb-2">
          <Input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cables…"
            aria-label="Search cables"
            className="h-8 text-sm"
            onKeyDown={(e) => {
              // The menu's type-to-find stays out of the box; the arrows
              // step into the list, Enter picks the first match.
              if (e.key === "ArrowDown") {
                e.preventDefault()
                list.current
                  ?.querySelector<HTMLElement>("[role=menuitem]")
                  ?.focus()
              } else if (e.key === "Enter") {
                e.preventDefault()
                if (shown[0]) onPick(shown[0].id)
              }
              if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation()
            }}
          />
        </div>
      )}
      <DropdownMenuSeparator className="my-0" />
      <div
        ref={list}
        className="max-h-72 overflow-y-auto p-1"
        onPointerLeave={() => onPreview(null)}
      >
        {shown.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No cables match.
          </p>
        )}
        {shown.map((r) => (
          <DropdownMenuItem
            key={r.id}
            data-cable-choice={r.id}
            className="flex-col items-stretch gap-0.5 py-1.5"
            onFocus={() => onPreview(r.id)}
            onPointerEnter={() => onPreview(r.id)}
            onSelect={() => onPick(r.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              {/* The cable's colour as a short run of it. */}
              <span
                aria-hidden
                data-part="swatch"
                className="h-1 w-4 shrink-0 rounded-sm"
                style={{ background: r.color ?? CABLE_NONE }}
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {r.label}
              </span>
              <StatusBadge status={r.status} className="shrink-0" />
            </span>
            <span className="truncate pl-6 text-xs text-muted-foreground">
              {r.ends}
            </span>
          </DropdownMenuItem>
        ))}
      </div>
    </>
  )
}
