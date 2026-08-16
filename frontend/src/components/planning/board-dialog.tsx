import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PlanningBoard,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormText } from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { apiErrorToast } from "@/lib/api-toast"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
}

/** Create or edit a board — name, description, tags. The slug is derived from
 * the name on create and left alone on edit (it's in nobody's URLs, but stable
 * identifiers shouldn't churn on a rename). */
export function BoardDialog({
  board,
  onOpenChange,
}: {
  /** Present = edit; absent = create. */
  board?: PlanningBoard
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const isEdit = !!board
  const [name, setName] = useState(board?.name ?? "")
  const [description, setDescription] = useState(board?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    board?.tags.map((t) => t.id) ?? []
  )

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description,
        tag_ids: tagIds,
      }
      if (isEdit)
        return api<PlanningBoard>(`/api/planning/boards/${board.id}/`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      return api<PlanningBoard>("/api/planning/boards/", {
        method: "POST",
        body: JSON.stringify({ ...body, slug: slugify(name) }),
      })
    },
    onSuccess: () => {
      toast.success(isEdit ? "Board saved" : "Board created")
      qc.invalidateQueries({ queryKey: ["planning-boards"] })
      qc.invalidateQueries({ queryKey: ["planning-board"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit board" : "New board"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            placeholder="DC migration"
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="optional"
          />
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Tags</label>
            <TagMultiSelect
              options={tags.data?.results ?? []}
              value={tagIds}
              onChange={setTagIds}
            />
          </div>
          {!isEdit && (
            <p className="text-[11px] text-muted-foreground">
              New boards start with Backlog, To do, In progress and Done —
              rename, recolor or replace them under Statuses.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
