import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Tag, TagMergeResult } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/forms/field"

/** The tags ``source`` may merge into: the same scope or wider. A global
 * tag only into another global tag; a tenant tag into a global one, a
 * tenant-wide one, or one local to its own site. Mirrors the server. */
export function mergeTargets(source: Tag, tags: Tag[]): Tag[] {
  return tags.filter((t) => {
    if (t.id === source.id) return false
    if (source.is_global) return !!t.is_global
    if (t.is_global) return true
    return !t.owning_site || t.owning_site.id === source.owning_site?.id
  })
}

export interface TagMergeDialogProps {
  tag: Tag | null
  /** Every tag on the page - the picker offers the valid targets. */
  tags: Tag[]
  onOpenChange: (open: boolean) => void
}

export function TagMergeDialog({
  tag,
  tags,
  onOpenChange,
}: TagMergeDialogProps) {
  const [into, setInto] = useState<string | null>(null)
  const qc = useQueryClient()
  const options = useMemo<ComboboxOption[]>(
    () =>
      tag
        ? mergeTargets(tag, tags).map((t) => ({
            value: String(t.id),
            label: t.name,
            color: t.color || null,
            badge: true,
            hint: t.is_global
              ? "global"
              : t.owning_site
                ? t.owning_site.name
                : undefined,
          }))
        : [],
    [tag, tags]
  )
  const target = tags.find((t) => String(t.id) === into)
  const usage = tag?.usage_count ?? 0

  function close(open: boolean) {
    if (!open) setInto(null)
    onOpenChange(open)
  }

  const m = useMutation({
    mutationFn: () =>
      api<TagMergeResult>(`/api/tags/${tag!.id}/merge/`, {
        method: "POST",
        body: JSON.stringify({ into: Number(into) }),
      }),
    onSuccess: (r) => {
      toast.success(`Merged ${tag!.name} into ${r.into.name}`)
      qc.invalidateQueries({ queryKey: ["tags"] })
      qc.invalidateQueries({ queryKey: ["tags-picker"] })
      close(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog open={!!tag} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge {tag?.name}</DialogTitle>
          <DialogDescription>
            {target
              ? `${usage} object${usage === 1 ? "" : "s"} move to ${target.name}. ${tag?.name} is deleted.`
              : `${usage} object${usage === 1 ? "" : "s"} tagged.`}
          </DialogDescription>
        </DialogHeader>
        <Field label="Merge into">
          <Combobox
            value={into}
            onChange={setInto}
            options={options}
            placeholder="Pick a tag…"
            searchPlaceholder="Search tags…"
            emptyText="No tags to merge into."
          />
        </Field>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => close(false)}
            disabled={m.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => m.mutate()}
            disabled={!into || m.isPending}
          >
            {m.isPending ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
