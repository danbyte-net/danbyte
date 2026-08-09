import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { CalendarClock, Flag, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useQuery } from "@tanstack/react-query"

import {
  api,
  type Paginated,
  type PlanningMilestone,
  type PlanningPriority,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Field, FormDate, FormSelect, FormText } from "@/components/forms"
import { Markdown } from "@/components/markdown"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { JournalPanel } from "@/components/audit/journal-panel"
import { apiErrorToast } from "@/lib/api-toast"
import { PriorityBadge, scheduleLabel } from "./task-card"
import { TaskLinkPanel } from "./task-link-panel"
import { UserPicker } from "./user-picker"

const PRIORITIES: { value: PlanningPriority; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
]

/** The task detail sheet: edit fields, linked objects, comments (Journal). */
export function TaskDetailSheet({
  task,
  statuses,
  onOpenChange,
}: {
  task: PlanningTask
  statuses: PlanningStatus[]
  onOpenChange: (open: boolean) => void
}) {
  const { canDo } = useMe()
  const canEdit = canDo("task", "change")
  const canDelete = canDo("task", "delete")
  const qc = useQueryClient()

  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [status, setStatus] = useState<string | null>(task.status)
  const [priority, setPriority] = useState<PlanningPriority>(task.priority)
  const [assignees, setAssignees] = useState<number[]>(task.assignees)
  const [startDate, setStartDate] = useState<string | null>(task.start_date)
  const [dueDate, setDueDate] = useState<string | null>(task.due_date)
  const [milestone, setMilestone] = useState<string | null>(task.milestone)

  const milestonesQ = useQuery({
    queryKey: ["planning-milestones", task.board],
    queryFn: () =>
      api<Paginated<PlanningMilestone>>(
        `/api/planning/milestones/?board=${task.board}&page_size=100`
      ),
  })
  const milestones = milestonesQ.data?.results ?? []
  const [descTab, setDescTab] = useState<"write" | "preview">(
    task.description ? "preview" : "write"
  )

  const { formatDate, today } = useDateFormat()
  const schedule = scheduleLabel(task, today, formatDate)
  const statusColor = statuses.find((s) => s.id === task.status)?.color ?? ""

  const dirty =
    title !== task.title ||
    description !== task.description ||
    status !== task.status ||
    priority !== task.priority ||
    startDate !== task.start_date ||
    dueDate !== task.due_date ||
    milestone !== task.milestone ||
    JSON.stringify([...assignees].sort()) !==
      JSON.stringify([...task.assignees].sort())

  const save = useMutation({
    mutationFn: () =>
      api(`/api/planning/tasks/${task.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description,
          status,
          priority,
          assignees,
          milestone,
          start_date: startDate,
          due_date: dueDate,
        }),
      }),
    onSuccess: () => {
      toast.success("Task saved")
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      // Milestone task_count is a server-side roll-up: moving a task between
      // milestones changes two of them, so refresh the whole list.
      qc.invalidateQueries({ queryKey: ["planning-milestones"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const del = useMutation({
    mutationFn: () =>
      api(`/api/planning/tasks/${task.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Task deleted")
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
      qc.invalidateQueries({ queryKey: ["planning-milestones"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-5 data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="p-0">
          <SheetTitle className="sr-only">{task.title}</SheetTitle>
        </SheetHeader>

        <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <ColorBadge
            name={task.status_name}
            color={statusColor || undefined}
          />
          <PriorityBadge priority={task.priority} />
          {schedule && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] ${schedule.tone}`}
            >
              <CalendarClock className="h-3 w-3" /> {schedule.text}
            </span>
          )}
          {task.milestone_name && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Flag className="h-3 w-3" /> {task.milestone_name}
            </span>
          )}
          <Link
            to="/planning/$boardId"
            params={{ boardId: task.board }}
            className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
          >
            {task.board_name}
          </Link>
        </div>

        <div className="grid gap-4">
          <FormText label="Title" value={title} onChange={setTitle} required />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormSelect
              label="Status"
              value={status}
              onChange={setStatus}
              options={statuses.map((s) => ({ value: s.id, label: s.name }))}
            />
            <FormSelect
              label="Priority"
              value={priority}
              onChange={(v) => setPriority((v as PlanningPriority) ?? "none")}
              options={PRIORITIES}
            />
          </div>

          <UserPicker value={assignees} onChange={setAssignees} />

          {milestones.length > 0 && (
            <FormSelect
              label="Milestone"
              value={milestone}
              onChange={setMilestone}
              noneLabel="No milestone"
              options={milestones.map((m) => ({
                value: m.id,
                label: m.due_date ? `${m.name} · ${m.due_date}` : m.name,
              }))}
            />
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormDate
              label="Start"
              value={startDate ?? ""}
              onChange={(v) => setStartDate(v || null)}
            />
            <FormDate
              label="Due"
              value={dueDate ?? ""}
              onChange={(v) => setDueDate(v || null)}
            />
          </div>

          <Field label="Description" hint="Markdown subset supported.">
            <SegmentedTabs
              className="mb-2"
              items={[
                { value: "write", label: "Write" },
                { value: "preview", label: "Preview" },
              ]}
              value={descTab}
              onValueChange={(v) => setDescTab(v as "write" | "preview")}
            />
            {descTab === "write" ? (
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-28 font-mono text-[13px]"
                placeholder="What needs to happen?"
              />
            ) : (
              <div className="rounded-md border border-border p-3">
                {description ? (
                  <Markdown source={description} />
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    Nothing written yet.
                  </p>
                )}
              </div>
            )}
          </Field>

          {canEdit && (
            <div className="flex items-center justify-between">
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={del.isPending}
                  onClick={() => del.mutate()}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              ) : (
                <span />
              )}
              <Button
                size="sm"
                disabled={!dirty || !title.trim() || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          )}

          <TaskLinkPanel
            taskId={task.id}
            boardId={task.board}
            links={task.links}
            canEdit={canEdit}
          />

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Comments
            </h3>
            <JournalPanel objectType="planning.task" objectId={task.id} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
