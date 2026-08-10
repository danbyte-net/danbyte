import { useState } from "react"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { CalendarClock } from "lucide-react"

import { api, type Paginated, type PlanningTask } from "@/lib/api"
import { OBJECT_DETAIL_ROUTES } from "@/lib/object-routes"
import { isPlanCapable } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/**
 * "Plan a change" from the object's own page.
 *
 * The other entry point is the task's linked-object row, but operators live on
 * device pages — they notice the thing that needs changing there, not on a board.
 * Pick the task the work belongs to and this drops straight into the object's
 * edit form in plan mode.
 *
 * Route-derived like `DetailActions`, so it mounts in `DetailShell` once and
 * works on every detail page whose type is plan-capable, with no per-page props.
 */

/** `/devices/<uuid>` → `api.device`, by inverting the detail-route table. */
function typeForPath(
  pathname: string
): { objectType: string; id: string } | null {
  const m = pathname.match(/^\/([a-z-]+)\/([0-9a-fA-F-]{36})\/?$/)
  if (!m) return null
  const route = `/${m[1]}/$id`
  for (const [label, to] of Object.entries(OBJECT_DETAIL_ROUTES)) {
    if (to === route) return { objectType: label, id: m[2] }
  }
  return null
}

export function PlanFromObject() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { canDo } = useMe()
  const nav = useNavigate()
  const { formatDate } = useDateFormat()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")

  const target = typeForPath(pathname)
  const enabled = open && !!target

  const tasks = useQuery({
    queryKey: ["planning-tasks", "picker", q],
    queryFn: () =>
      api<Paginated<PlanningTask>>(
        `/api/planning/tasks/?page_size=20&${new URLSearchParams({ q }).toString()}`
      ),
    enabled,
    staleTime: 30_000,
  })

  if (!target || !isPlanCapable(target.objectType)) return null
  // Recording a change on a task is editing that task.
  if (!canDo("task", "change")) return null

  const rows = tasks.data?.results ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title="Record a change to this object on a planning task"
        >
          <CalendarClock className="h-3.5 w-3.5" /> Plan a change
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Which task is this for?"
          className="mb-2 h-8"
        />
        <div className="max-h-64 overflow-y-auto">
          {tasks.isLoading && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Loading...
            </p>
          )}
          {!tasks.isLoading && rows.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {q ? "No task matches." : "No tasks yet — create one on a board."}
            </p>
          )}
          {rows.map((t) => (
            <button
              key={t.id}
              type="button"
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              onClick={() => {
                setOpen(false)
                nav({
                  to: `${OBJECT_DETAIL_ROUTES[target.objectType].replace("$id", target.id)}/edit`,
                  search: { plan: t.id, planBoard: t.board },
                })
              }}
            >
              <span className="text-[13px] leading-tight">{t.title}</span>
              <span className="text-[11px] text-muted-foreground">
                {t.board_name} · {t.status_name}
                {t.due_date ? ` · due ${formatDate(t.due_date)}` : ""}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
