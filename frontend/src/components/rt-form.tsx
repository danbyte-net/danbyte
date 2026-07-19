import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type RouteTarget,
  type RouteTargetWritePayload,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors } from "@/components/forms"

export interface RtFormProps {
  rt?: RouteTarget
  onSaved: (saved: RouteTarget) => void
  onCancel: () => void
}

export function RtForm({ rt, onSaved, onCancel }: RtFormProps) {
  const isEdit = !!rt
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(rt?.name ?? "")
  const [description, setDescription] = useState(rt?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    rt?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    rt?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!rt) return
    setName(rt.name)
    setDescription(rt.description)
    setTagIds(rt.tags.map((t) => t.id))
    setCustomFields(rt.custom_fields ?? {})
    reset()
  }, [rt, reset])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RouteTargetWritePayload = {
        name: name.trim(),
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<RouteTarget>(`/api/route-targets/${rt!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<RouteTarget>("/api/route-targets/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["rts"] })
      qc.invalidateQueries({ queryKey: ["rts-picker"] })
      qc.invalidateQueries({ queryKey: ["rt", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <Field
        label="Name"
        hint="ASN:value, e.g. 65000:100"
        error={fieldErrors.name}
      >
        <Input
          autoFocus={!isEdit}
          required
          placeholder="65000:100"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="font-mono"
        />
      </Field>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Shared production hub RT"
        />
      </Field>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>

      <CustomFieldInputs
        model="routetarget"
        value={customFields}
        onChange={setCustomFields}
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create RT"}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
