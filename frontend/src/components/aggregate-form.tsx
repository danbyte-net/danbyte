import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Aggregate,
  type AggregateWritePayload,
  type Paginated,
  type RIROption,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors } from "@/components/forms"

export interface AggregateFormProps {
  aggregate?: Aggregate
  onSaved: (saved: Aggregate) => void
  onCancel: () => void
}

export function AggregateForm({
  aggregate,
  onSaved,
  onCancel,
}: AggregateFormProps) {
  const isEdit = !!aggregate
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [prefix, setPrefix] = useState(aggregate?.prefix ?? "")
  const [rirId, setRirId] = useState<string | null>(aggregate?.rir?.id ?? null)
  const [dateAdded, setDateAdded] = useState(aggregate?.date_added ?? "")
  const [description, setDescription] = useState(aggregate?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    aggregate?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    aggregate?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!aggregate) return
    setPrefix(aggregate.prefix)
    setRirId(aggregate.rir?.id ?? null)
    setDateAdded(aggregate.date_added ?? "")
    setDescription(aggregate.description)
    setTagIds(aggregate.tags.map((t) => t.id))
    setCustomFields(aggregate.custom_fields ?? {})
    reset()
  }, [aggregate, reset])

  const rirs = useQuery({
    queryKey: ["rirs-picker"],
    queryFn: () => api<Paginated<RIROption>>("/api/rirs/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: AggregateWritePayload = {
        prefix: prefix.trim(),
        rir_id: rirId ?? "",
        date_added: dateAdded || null,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Aggregate>(`/api/aggregates/${aggregate!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Aggregate>("/api/aggregates/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["aggregates"] })
      qc.invalidateQueries({ queryKey: ["aggregate", saved.id] })
      qc.invalidateQueries({ queryKey: ["rir-aggregates"] })
      toast.success(
        isEdit ? `Updated ${saved.prefix}` : `Created ${saved.prefix}`
      )
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
      <Field label="Prefix (CIDR)" error={fieldErrors.prefix}>
        <Input
          autoFocus={!isEdit}
          required
          placeholder="10.0.0.0/8"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          className="font-mono"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="RIR" error={fieldErrors.rir_id}>
          <Select value={rirId ?? ""} onValueChange={(v) => setRirId(v)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a RIR" />
            </SelectTrigger>
            <SelectContent>
              {rirs.data?.results.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Date added"
          hint="optional"
          error={fieldErrors.date_added}
        >
          <DatePicker value={dateAdded} onChange={setDateAdded} />
        </Field>
      </div>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. RFC1918 private block"
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
        model="aggregate"
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
        <Button type="submit" disabled={mutation.isPending || !rirId}>
          {mutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create aggregate"}
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
