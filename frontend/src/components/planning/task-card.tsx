import { useDraggable } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import {
  AlignLeft,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  Flag,
  Minus,
  type LucideIcon,
} from "lucide-react"

import { type PlanningPriority, type PlanningTask } from "@/lib/api"
import { daysBetween, useDateFormat } from "@/lib/datetime"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar"
import { ObjectChip, slugFromObjectType } from "./object-chip"

// Priority reads as a labelled badge, never a colored dot: the icon carries the
// direction, the tint carries the urgency, and the word says which is which.
const PRIORITY: Record<
  PlanningPriority,
  { label: string; icon: LucideIcon; className: string } | null
> = {
  none: null,
  low: {
    label: "Low",
    icon: ChevronDown,
    className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
  medium: {
    label: "Medium",
    icon: Minus,
    className: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  },
  high: {
    label: "High",
    icon: ChevronUp,
    className:
      "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  },
  urgent: {
    label: "Urgent",
    icon: ChevronsUp,
    className: "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300",
  },
}

export function PriorityBadge({ priority }: { priority: PlanningPriority }) {
  const p = PRIORITY[priority]
  if (!p) return null
  const Icon = p.icon
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium ${p.className}`}
    >
      <Icon className="h-3 w-3" /> {p.label}
    </span>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
}

/** Schedule wording that answers "when?" without opening the card: how far off
 * the due date is, plus the date itself once it is more than a week out. */
export function scheduleLabel(
  task: Pick<PlanningTask, "start_date" | "due_date">,
  today: string,
  formatDate: (v: string) => string
): { text: string; tone: string } | null {
  if (!task.due_date) {
    if (!task.start_date) return null
    const d = daysBetween(today, task.start_date)
    return {
      text: d > 0 ? `Starts ${formatDate(task.start_date)}` : "Started",
      tone: "text-muted-foreground",
    }
  }
  const d = daysBetween(today, task.due_date)
  const date = formatDate(task.due_date)
  if (d < 0)
    return {
      text: `${-d} day${d === -1 ? "" : "s"} overdue · ${date}`,
      tone: "text-red-600 dark:text-red-400",
    }
  if (d === 0)
    return {
      text: `Due today · ${date}`,
      tone: "text-amber-600 dark:text-amber-400",
    }
  if (d === 1)
    return {
      text: `Due tomorrow · ${date}`,
      tone: "text-amber-600 dark:text-amber-400",
    }
  if (d <= 7)
    return { text: `Due in ${d} days · ${date}`, tone: "text-muted-foreground" }
  return { text: `Due ${date}`, tone: "text-muted-foreground" }
}

/** One kanban card. Draggable via dnd-kit (6px activation upstream keeps plain
 * clicks working); clicking opens the detail sheet. The card is meant to answer
 * "what, which object, and when" on its own — linked inventory renders as real
 * chips so the board reads as part of Danbyte, not beside it. */
export function TaskCard({
  task,
  onOpen,
}: {
  task: PlanningTask
  onOpen: (task: PlanningTask) => void
}) {
  const drag = useDraggable({ id: `task|${task.id}` })
  const { formatDate, today } = useDateFormat()
  const style = drag.transform
    ? { transform: CSS.Translate.toString(drag.transform) }
    : undefined

  const shownLinks = task.links.slice(0, 3)
  const extraLinks = task.links.length - shownLinks.length
  const schedule = scheduleLabel(task, today, formatDate)
  const hasTopRow =
    task.priority !== "none" ||
    task.label_detail.length > 0 ||
    task.assignee_detail.length > 0 ||
    !!task.assigned_group_name

  return (
    <div
      ref={drag.setNodeRef}
      {...drag.attributes}
      {...drag.listeners}
      style={style}
      onClick={() => onOpen(task)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(task)
      }}
      className={`w-full cursor-pointer touch-none space-y-2 rounded-lg border border-border bg-card p-3 text-left shadow-none transition-colors hover:border-primary/40 ${
        drag.isDragging ? "opacity-40" : ""
      }`}
    >
      {hasTopRow && (
        <div className="flex items-center gap-1.5">
          <PriorityBadge priority={task.priority} />
          {task.label_detail.slice(0, 2).map((l) => (
            <span
              key={l.id}
              className="max-w-[7rem] truncate rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: l.color ? `${l.color}26` : undefined,
                color: l.color || undefined,
              }}
            >
              {l.name}
            </span>
          ))}
          {/* The team queue owning the task; assignees are the doers. */}
          {task.assigned_group_name && (
            <span
              className={[
                task.assignee_detail.length ? "" : "ml-auto",
                "max-w-[8rem] truncate rounded-[5px] bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
              ].join(" ")}
              title={`Team: ${task.assigned_group_name}`}
            >
              {task.assigned_group_name}
            </span>
          )}
          {task.assignee_detail.length > 0 && (
            <span
              className="ml-auto flex min-w-0 shrink items-center gap-1.5"
              title={task.assignee_detail.map((a) => a.username).join(", ")}
            >
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
              {/* Initials alone don't answer "who has this?" — name the single
                  assignee, and count the rest rather than a row of riddles. */}
              <span className="truncate text-[11px] text-muted-foreground">
                {task.assignee_detail.length === 1
                  ? task.assignee_detail[0].username
                  : `${task.assignee_detail.length} assignees`}
              </span>
            </span>
          )}
        </div>
      )}

      <p className="text-[13px] leading-snug font-medium">{task.title}</p>

      {shownLinks.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {shownLinks.map((l) => (
            <ObjectChip
              key={l.id}
              slug={slugFromObjectType(l.object_type)}
              id={l.object_id}
            />
          ))}
          {extraLinks > 0 && (
            <span className="text-[11px] text-muted-foreground">
              +{extraLinks} more
            </span>
          )}
        </div>
      )}

      {(schedule || task.milestone_name || task.description) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2">
          {schedule && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] ${schedule.tone}`}
            >
              <CalendarClock className="h-3 w-3" /> {schedule.text}
            </span>
          )}
          {task.milestone_name && (
            <span className="inline-flex max-w-[10rem] items-center gap-1 text-[11px] text-muted-foreground">
              <Flag className="h-3 w-3 shrink-0" />
              <span className="truncate">{task.milestone_name}</span>
            </span>
          )}
          {task.description && (
            <AlignLeft
              className="h-3 w-3 text-muted-foreground"
              aria-label="Has a description"
            />
          )}
        </div>
      )}
    </div>
  )
}
