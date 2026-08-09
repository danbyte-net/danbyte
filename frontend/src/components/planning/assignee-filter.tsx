import { CircleDashed } from "lucide-react"

import { type PlanningTask } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"

export type AssigneeFilter = number | "unassigned" | null

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
}

/** Who is working on this board, as faces in the header. Clicking one filters
 * the board to their tasks — the board-level answer to "who has what", which
 * per-card avatars alone can't give you. Derived from the tasks already loaded,
 * so it costs no extra request and never lists someone with nothing to do. */
export function AssigneeFilterStrip({
  tasks,
  value,
  onChange,
}: {
  tasks: PlanningTask[]
  value: AssigneeFilter
  onChange: (v: AssigneeFilter) => void
}) {
  const { me } = useMe()
  const byId = new Map<number, { username: string; count: number }>()
  let unassigned = 0
  for (const t of tasks) {
    if (t.assignee_detail.length === 0) unassigned++
    for (const a of t.assignee_detail) {
      const hit = byId.get(a.id)
      if (hit) hit.count++
      else byId.set(a.id, { username: a.username, count: 1 })
    }
  }
  if (byId.size === 0 && unassigned === 0) return null

  // The signed-in user first — "my work" is the most common question. /api/me/
  // identifies the user by username, so that is what we match on.
  const isMe = (username: string) => !!me.username && username === me.username
  const people = [...byId.entries()].sort((a, b) => {
    if (isMe(a[1].username)) return -1
    if (isMe(b[1].username)) return 1
    return a[1].username.localeCompare(b[1].username)
  })

  const chip = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
      active
        ? "border-primary/40 bg-primary/10 text-foreground"
        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
    )

  return (
    <div className="flex flex-wrap items-center gap-1">
      {people.map(([id, p]) => {
        const active = value === id
        return (
          <button
            key={id}
            type="button"
            className={chip(active)}
            aria-pressed={active}
            title={`${p.username} — ${p.count} task${p.count === 1 ? "" : "s"}`}
            onClick={() => onChange(active ? null : id)}
          >
            <Avatar size="sm">
              <AvatarFallback className="text-[9px]">
                {initials(p.username)}
              </AvatarFallback>
            </Avatar>
            <span className="max-w-[8rem] truncate">
              {isMe(p.username) ? "Me" : p.username}
            </span>
            <span className="num opacity-70">{p.count}</span>
          </button>
        )
      })}
      {unassigned > 0 && (
        <button
          type="button"
          className={chip(value === "unassigned")}
          aria-pressed={value === "unassigned"}
          title={`${unassigned} unassigned task${unassigned === 1 ? "" : "s"}`}
          onClick={() => onChange(value === "unassigned" ? null : "unassigned")}
        >
          <CircleDashed className="h-3.5 w-3.5" />
          Unassigned
          <span className="num opacity-70">{unassigned}</span>
        </button>
      )}
    </div>
  )
}

/** Apply the strip's selection. Kept next to the strip so the filter's meaning
 * lives in one place. */
export function filterByAssignee(
  tasks: PlanningTask[],
  filter: AssigneeFilter
): PlanningTask[] {
  if (filter === null) return tasks
  if (filter === "unassigned")
    return tasks.filter((t) => t.assignee_detail.length === 0)
  return tasks.filter((t) => t.assignees.includes(filter))
}
