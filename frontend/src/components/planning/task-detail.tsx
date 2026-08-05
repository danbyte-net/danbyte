import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type PlanningPriority,
  type PlanningStatus,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
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
  const [descTab, setDescTab] = useState<"write" | "preview">(
    task.description ? "preview" : "write"
  )

  const dirty =
    title !== task.title ||
    description !== task.description ||
    status !== task.status ||
    priority !== task.priority ||
    startDate !== task.start_date ||
    dueDate !== task.due_date ||
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
          start_date: startDate,
          due_date: dueDate,
        }),
      }),
    onSuccess: () => {
      toast.success("Task saved")
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const del = useMutation({
    mutationFn: () =>
      api(`/api/planning/tasks/${task.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Task deleted")
      qc.invalidateQueries({ queryKey: ["planning-tasks"] })
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
