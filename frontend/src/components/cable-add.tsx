import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { api, type Cable, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** Server-searched cable picker — used by the floor-plan tray inspector and
 * the site map's route inspector to assign physical cables to a run. */
export function CableAdd({
  excludeIds,
  onAdd,
}: {
  excludeIds: string[]
  onAdd: (cableId: string, cable: Cable) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["cables-search", q],
    queryFn: () =>
      api<Paginated<Cable>>(
        `/api/cables/?${new URLSearchParams({ search: q }).toString()}`
      ),
    enabled: open,
  })
  const rows = (query.data?.results ?? []).filter(
    (c) => !excludeIds.includes(c.id)
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <Plus className="h-3.5 w-3.5" /> Add cable
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <Input
          autoFocus
          placeholder="Search cables…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="mb-1 h-8 text-xs"
        />
        <div className="max-h-56 overflow-y-auto">
          {query.isLoading && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading…
            </p>
          )}
          {query.data && rows.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No cables found.
            </p>
          )}
          {rows.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onAdd(c.id, c)
                setOpen(false)
                setQ("")
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted/60"
            >
              {c.color && (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
              )}
              <span className="truncate font-mono text-xs">
                {c.label || `Cable #${c.numid}`}
              </span>
              {c.type_display && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {c.type_display}
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
