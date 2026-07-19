import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type ASN,
  type ASNWritePayload,
  type Paginated,
  type RIROption,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
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
import { SiteMultiSelect } from "@/components/cells/site-multi-select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors } from "@/components/forms"

export interface AsnFormProps {
  asn?: ASN
  onSaved: (saved: ASN) => void
  onCancel: () => void
}

const NONE = "__none__"

export function AsnForm({ asn, onSaved, onCancel }: AsnFormProps) {
  const isEdit = !!asn
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [number, setNumber] = useState(asn ? String(asn.asn) : "")
  const [rirId, setRirId] = useState<string | null>(asn?.rir?.id ?? null)
  const [siteIds, setSiteIds] = useState<string[]>(
    asn?.sites.map((s) => s.id) ?? []
  )
  const [description, setDescription] = useState(asn?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    asn?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    asn?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!asn) return
    setNumber(String(asn.asn))
    setRirId(asn.rir?.id ?? null)
    setSiteIds(asn.sites.map((s) => s.id))
    setDescription(asn.description)
    setTagIds(asn.tags.map((t) => t.id))
    setCustomFields(asn.custom_fields ?? {})
    reset()
  }, [asn, reset])

  const rirs = useQuery({
    queryKey: ["rirs-picker"],
    queryFn: () => api<Paginated<RIROption>>("/api/rirs/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const sites = useSiteOptions()
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ASNWritePayload = {
        asn: Number(number),
        rir_id: rirId,
        site_ids: siteIds,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<ASN>(`/api/asns/${asn!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ASN>("/api/asns/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["asns"] })
      qc.invalidateQueries({ queryKey: ["asn", saved.id] })
      toast.success(
        isEdit ? `Updated AS${saved.asn}` : `Created AS${saved.asn}`
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
      <Field label="AS number" error={fieldErrors.asn}>
        <Input
          autoFocus={!isEdit}
          required
          type="number"
          min={1}
          max={4294967295}
          placeholder="65001"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          className="font-mono"
        />
      </Field>

      <Field label="RIR" hint="optional" error={fieldErrors.rir_id}>
        <Select
          value={rirId ?? NONE}
          onValueChange={(v) => setRirId(v === NONE ? null : v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No RIR" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No RIR</SelectItem>
            {rirs.data?.results.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Sites" hint="optional">
        <SiteMultiSelect
          options={sites.options}
          value={siteIds}
          onChange={setSiteIds}
        />
      </Field>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Edge / transit AS"
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
        model="asn"
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
              : "Create ASN"}
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
