import { useDraggable } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"

import { type PlanningPriority, type PlanningTask } from "@/lib/api"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar"

const PRIORITY_DOT: Record<PlanningPriority, string> = {
  none: "",
  low: "bg-zinc-400",
  medium: "bg-sky-500",
  high: "bg-amber-500",
  urgent: "bg-red-500",
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
}

function dueTone(due: string | null): string {
  if (!due) return ""
  const today = new Date().toISOString().slice(0, 10)
  if (due < today) return "text-red-600 dark:text-red-400"
  if (due === today) return "text-amber-600 dark:text-amber-400"
  return "text-muted-foreground"
}

/** One kanban card. Draggable via dnd-kit (6px activation upstream keeps plain
 * clicks working); clicking opens the detail sheet. */
export function TaskCard({
  task,
  onOpen,
}: {
  task: PlanningTask
  onOpen: (task: PlanningTask) => void
}) {
  const drag = useDraggable({ id: `task|${task.id}` })
  const style = drag.transform
    ? { transform: CSS.Translate.toString(drag.transform) }
    : undefined

  const dot = PRIORITY_DOT[task.priority]
  const hasMeta =
    task.due_date || task.label_detail.length > 0 || task.links.length > 0

  return (
    <button
      type="button"
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      style={style}
      onClick={() => onOpen(task)}
      className={`w-full touch-none rounded-lg border border-border bg-card p-3 text-left shadow-none transition-colors hover:border-primary/40 ${
        drag.isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        {dot && (
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
        )}
        <span className="min-w-0 flex-1 text-[13px] leading-snug font-medium">
          {task.title}
        </span>
        {task.assignee_detail.length > 0 && (
          <AvatarGroup className="shrink-0">
            {task.assignee_detail.slice(0, 3).map((a) => (
              <Avatar key={a.id} size="sm">
                <AvatarFallback className="text-[9px]">
                  {initials(a.username)}
                </AvatarFallback>
              </Avatar>
            ))}
            {task.assignee_detail.length > 3 && (
              <AvatarGroupCount>
                +{task.assignee_detail.length - 3}
              </AvatarGroupCount>
            )}
          </AvatarGroup>
        )}
      </div>
      {hasMeta && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          {task.due_date && (
            <span className={`text-[11px] ${dueTone(task.due_date)}`}>
              {task.due_date}
            </span>
          )}
          {task.links.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {task.links.length} linked
            </span>
          )}
          {task.label_detail.map((l) => (
            <span
              key={l.id}
              className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: l.color ? `${l.color}26` : undefined,
                color: l.color || undefined,
              }}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
