import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Maximize2, Minimize2, Trash2 } from "lucide-react"
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
import { PlannedChangePanel } from "./planned-change-panel"
import { TaskLinkPanel } from "./task-link-panel"
import { UserPicker } from "./user-picker"

const PRIORITIES: { value: PlanningPriority; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
]

const WIDE_KEY = "danbyte.planning.task-sheet-wide"

const readWide = () => {
  try {
    return window.localStorage.getItem(WIDE_KEY) === "1"
  } catch {
    return false
  }
}

/** The task detail sheet: edit fields on the left, everything *about* the task
 *  (linked objects, planned changes, comments) on the right once expanded. */
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
  const [wide, setWide] = useState(readWide)

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

  const { formatDate } = useDateFormat()

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
        className={
          wide
            ? "w-full overflow-y-auto p-5 data-[side=right]:sm:max-w-[min(1400px,96vw)]"
            : "w-full overflow-y-auto p-5 data-[side=right]:sm:max-w-xl"
        }
      >
        <SheetHeader className="p-0">
          <SheetTitle className="sr-only">{task.title}</SheetTitle>
        </SheetHeader>

        {/* Status, priority, milestone and both dates are editable fields a few
            pixels below. Repeating them as badges up here doubled the reading
            load for no new information, so the header carries only what the
            fields cannot: where this task lives, and room to breathe. */}
        {/* pr-10 keeps the toggle clear of the sheet's own absolute close X. */}
        <div className="mb-4 flex items-center gap-2 border-b border-border pr-10 pb-3">
          <Link
            to="/planning/$boardId"
            params={{ boardId: task.board }}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {task.board_name}
          </Link>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            title={wide ? "Collapse to a side panel" : "Expand to full width"}
            onClick={() =>
              setWide((w) => {
                try {
                  window.localStorage.setItem(WIDE_KEY, w ? "0" : "1")
                } catch {
                  /* private mode — the toggle still works for this session */
                }
                return !w
              })
            }
          >
            {wide ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
            {wide ? "Collapse" : "Expand"}
          </Button>
        </div>

        <div
          className={
            wide
              ? "grid items-start gap-x-8 gap-y-4 lg:grid-cols-2"
              : "grid gap-4"
          }
        >
          <div className="grid content-start gap-4">
            {/* The panels on the other side are all `<section>` + uppercase
                heading; the form gets one too, so both columns read alike. */}
            <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Details
            </h3>
            <FormText
              label="Title"
              value={title}
              onChange={setTitle}
              required
            />

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
                  label: m.due_date
                    ? `${m.name} · ${formatDate(m.due_date)}`
                    : m.name,
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
          </div>

          <div className="grid content-start gap-4">
            <TaskLinkPanel
              taskId={task.id}
              boardId={task.board}
              links={task.links}
              canEdit={canEdit}
            />

            <PlannedChangePanel task={task} canEdit={canEdit} />

            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Comments
              </h3>
              <JournalPanel objectType="planning.task" objectId={task.id} />
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
