import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type RouteTargetMini,
  type TagOption,
  type VRF,
  type VRFWritePayload,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { RtMultiSelect } from "@/components/cells/rt-multi-select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { ColorPicker } from "@/components/ui/color-picker"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors } from "@/components/forms"

export interface VrfFormProps {
  vrf?: VRF
  onSaved: (saved: VRF) => void
  onCancel: () => void
}

export function VrfForm({ vrf, onSaved, onCancel }: VrfFormProps) {
  const isEdit = !!vrf
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(vrf?.name ?? "")
  const [rd, setRd] = useState(vrf?.rd ?? "")
  const [color, setColor] = useState(vrf?.color ?? "")
  const [description, setDescription] = useState(vrf?.description ?? "")
  const [enforceUnique, setEnforceUnique] = useState(
    vrf?.enforce_unique ?? true
  )
  const [importIds, setImportIds] = useState<string[]>(
    vrf?.import_targets.map((t) => t.id) ?? []
  )
  const [exportIds, setExportIds] = useState<string[]>(
    vrf?.export_targets.map((t) => t.id) ?? []
  )
  const [tagIds, setTagIds] = useState<number[]>(
    vrf?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    vrf?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!vrf) return
    setName(vrf.name)
    setRd(vrf.rd)
    setColor(vrf.color)
    setDescription(vrf.description)
    setEnforceUnique(vrf.enforce_unique)
    setImportIds(vrf.import_targets.map((t) => t.id))
    setExportIds(vrf.export_targets.map((t) => t.id))
    setTagIds(vrf.tags.map((t) => t.id))
    setCustomFields(vrf.custom_fields ?? {})
    reset()
  }, [vrf, reset])

  const rts = useQuery({
    queryKey: ["rts-picker"],
    queryFn: () =>
      api<Paginated<RouteTargetMini>>("/api/route-targets/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VRFWritePayload = {
        name: name.trim(),
        rd: rd.trim(),
        color: color.trim(),
        description: description.trim(),
        enforce_unique: enforceUnique,
        import_target_ids: importIds,
        export_target_ids: exportIds,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<VRF>(`/api/vrfs/${vrf!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<VRF>("/api/vrfs/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vrfs"] })
      qc.invalidateQueries({ queryKey: ["vrfs-picker"] })
      qc.invalidateQueries({ queryKey: ["vrf", saved.id] })
      toast.success(
        isEdit ? `Updated VRF ${saved.name}` : `Created VRF ${saved.name}`
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
      <Field label="Name" error={fieldErrors.name}>
        <Input
          autoFocus={!isEdit}
          required
          placeholder="prod-vpn"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Route Distinguisher (RD)"
          hint="optional"
          error={fieldErrors.rd}
        >
          <Input
            placeholder="65001:100"
            value={rd}
            onChange={(e) => setRd(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="Color" hint="pick or paste hex" error={fieldErrors.color}>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
      </div>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Production east-coast L3VPN"
        />
      </Field>

      <Field label="Import targets" hint="RTs whose routes this VRF accepts">
        <RtMultiSelect
          options={rts.data?.results ?? []}
          value={importIds}
          onChange={setImportIds}
          placeholder="Add import RT…"
        />
      </Field>
      <Field
        label="Export targets"
        hint="RTs this VRF tags its own routes with"
      >
        <RtMultiSelect
          options={rts.data?.results ?? []}
          value={exportIds}
          onChange={setExportIds}
          placeholder="Add export RT…"
        />
      </Field>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>

      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox
          checked={enforceUnique}
          onCheckedChange={(v) => setEnforceUnique(!!v)}
        />
        Reject overlapping child prefixes within this VRF
      </label>

      <CustomFieldInputs
        model="vrf"
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
              : "Create VRF"}
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
