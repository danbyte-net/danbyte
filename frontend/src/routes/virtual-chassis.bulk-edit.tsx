import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  TagOption,
  VirtualChassisBulkUpdateFields,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { EditPageShell } from "@/components/edit-page-shell"
import { FieldEditor, useFieldEditorOptions } from "@/components/forms"
import type { BulkFieldSpec } from "@/components/forms/field-spec"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/virtual-chassis/bulk-edit")({
  validateSearch: (s: Record<string, unknown>) => ({
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
  component: BulkEditVirtualChassisPage,
})

// Name and master are per stack, so they stay on the single edit form.
const TEXT_FIELDS: BulkFieldSpec[] = [
  { key: "domain", label: "Domain", kind: "text" },
  { key: "description", label: "Description", kind: "text" },
]
type TextKey = "domain" | "description"

const noun = (n: number) => `${n} virtual chassis`

function BulkEditVirtualChassisPage() {
  const { ids: idsCsv } = Route.useSearch()
  const ids = idsCsv.split(",").filter(Boolean)
  const nav = useNavigate()
  const qc = useQueryClient()

  // undefined = keep; a string (even "") is written to every stack.
  const [text, setText] = useState<Partial<Record<TextKey, string>>>({})
  const editorOptions = useFieldEditorOptions(TEXT_FIELDS)
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const back = () => nav({ to: "/virtual-chassis" })

  const m = useMutation({
    mutationFn: () => {
      const fields: VirtualChassisBulkUpdateFields = {}
      if (text.domain !== undefined) fields.domain = text.domain
      if (text.description !== undefined) fields.description = text.description
      if (addTags.length) fields.add_tag_ids = addTags
      if (removeTags.length) fields.remove_tag_ids = removeTags
      if (Object.keys(fields).length === 0) {
        throw new Error("Pick at least one field to update.")
      }
      return api<{ updated: number }>("/api/virtual-chassis/bulk-update/", {
        method: "POST",
        body: JSON.stringify({ ids, fields }),
      })
    },
    onSuccess: (res) => {
      toast.success(`Updated ${noun(res.updated)}.`)
      qc.invalidateQueries({ queryKey: ["virtual-chassis"] })
      back()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (ids.length === 0) {
    return (
      <EditPageShell
        crumbs={[
          { label: "Virtual chassis", to: "/virtual-chassis" },
          { label: "Bulk edit" },
        ]}
        title="Bulk edit"
      >
        <p className="text-sm text-muted-foreground">
          No virtual chassis selected. Go back to the list and pick rows first.
        </p>
      </EditPageShell>
    )
  }

  return (
    <EditPageShell
      crumbs={[
        { label: "Virtual chassis", to: "/virtual-chassis" },
        { label: `Bulk edit (${ids.length})` },
      ]}
      title={`Bulk edit ${noun(ids.length)}`}
      subtitle="Only fields you change are applied. Tags are merged."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="grid gap-4"
      >
        {TEXT_FIELDS.map((spec) => (
          <FieldEditor
            key={spec.key}
            spec={spec}
            mode="keep"
            value={text[spec.key as TextKey]}
            onChange={(v) =>
              setText((prev) => ({ ...prev, [spec.key]: String(v ?? "") }))
            }
            onClear={() =>
              setText((prev) => ({ ...prev, [spec.key]: undefined }))
            }
            options={editorOptions}
          />
        ))}
        <Field label="Add tags">
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={addTags}
            onChange={setAddTags}
            placeholder="Tags to add…"
          />
        </Field>
        <Field label="Remove tags">
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={removeTags}
            onChange={setRemoveTags}
            placeholder="Tags to remove…"
          />
        </Field>

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={back}
            disabled={m.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Applying…" : `Apply to ${ids.length}`}
          </Button>
        </div>
      </form>
    </EditPageShell>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}
