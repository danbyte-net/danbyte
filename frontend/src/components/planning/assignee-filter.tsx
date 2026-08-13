import { CircleDashed } from "lucide-react"

import { type PlanningTask } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type AssigneeFilter = number | "unassigned" | null

/** Usernames are often email addresses. A header is no place for
 *  "hello@minecraft-vote.com" — the local part identifies the person, and the
 *  full value is one hover away. */
function shortName(username: string): string {
  const at = username.indexOf("@")
  return at > 0 ? username.slice(0, at) : username
}

function initials(name: string): string {
  const parts = shortName(name)
    .trim()
    .split(/[\s._-]+/)
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

  // Faces, not labelled chips. Six people used to mean six pills of differing
  // width — one of them a full email address — fighting the board title for the
  // header. The avatar is the control; the name and count live in the tooltip.
  const face = (active: boolean) =>
    cn(
      "relative rounded-full transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      active
        ? "opacity-100 ring-2 ring-primary ring-offset-1 ring-offset-background"
        : "opacity-60 hover:opacity-100"
    )

  return (
    <div className="flex items-center gap-1.5">
      {people.map(([id, p]) => {
        const active = value === id
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={face(active)}
                aria-pressed={active}
                aria-label={`${p.username}, ${p.count} task${p.count === 1 ? "" : "s"}`}
                onClick={() => onChange(active ? null : id)}
              >
                <Avatar size="sm">
                  <AvatarFallback className="text-[9px]">
                    {initials(p.username)}
                  </AvatarFallback>
                </Avatar>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isMe(p.username) ? "You" : shortName(p.username)} · {p.count}{" "}
              task{p.count === 1 ? "" : "s"}
            </TooltipContent>
          </Tooltip>
        )
      })}
      {unassigned > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                face(value === "unassigned"),
                "flex size-6 items-center justify-center text-muted-foreground"
              )}
              aria-pressed={value === "unassigned"}
              aria-label={`${unassigned} unassigned task${unassigned === 1 ? "" : "s"}`}
              onClick={() =>
                onChange(value === "unassigned" ? null : "unassigned")
              }
            >
              <CircleDashed className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Unassigned · {unassigned} task{unassigned === 1 ? "" : "s"}
          </TooltipContent>
        </Tooltip>
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
