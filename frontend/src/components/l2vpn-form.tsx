import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type L2VPN,
  type L2VPNType,
  type L2VPNWritePayload,
  type Paginated,
  type RouteTargetMini,
  type Status,
} from "@/lib/api"
import {
  Field,
  FormColumn,
  FormColumns,
  FormFooter,
  FormSection,
  FormSelect,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { RtMultiSelect } from "@/components/cells/rt-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

export const L2VPN_TYPES: { value: L2VPNType; label: string }[] = [
  { value: "vxlan", label: "VXLAN" },
  { value: "vxlan-evpn", label: "VXLAN-EVPN" },
  { value: "mpls-evpn", label: "MPLS-EVPN" },
  { value: "pbb-evpn", label: "PBB-EVPN" },
  { value: "vpws", label: "VPWS" },
  { value: "vpls", label: "VPLS" },
  { value: "epl", label: "EPL" },
  { value: "evpl", label: "EVPL" },
  { value: "spb", label: "SPB" },
  { value: "trill", label: "TRILL" },
]

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export interface L2vpnFormProps {
  l2vpn?: L2VPN
  onSaved: (v: L2VPN) => void
  onCancel: () => void
}

export function L2vpnForm({ l2vpn, onSaved, onCancel }: L2vpnFormProps) {
  const isEdit = !!l2vpn
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(l2vpn?.name ?? "")
  const [slug, setSlug] = useState(l2vpn?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [type, setType] = useState<L2VPNType>(l2vpn?.type ?? "vxlan")
  const [identifier, setIdentifier] = useState(
    l2vpn?.identifier != null ? String(l2vpn.identifier) : ""
  )
  const [statusId, setStatusId] = useState<string | null>(
    l2vpn?.status?.id ?? null
  )
  const [importIds, setImportIds] = useState<string[]>(
    l2vpn?.import_targets.map((t) => t.id) ?? []
  )
  const [exportIds, setExportIds] = useState<string[]>(
    l2vpn?.export_targets.map((t) => t.id) ?? []
  )
  const [description, setDescription] = useState(l2vpn?.description ?? "")
  const [comments, setComments] = useState(l2vpn?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    l2vpn?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    l2vpn?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!l2vpn) return
    setName(l2vpn.name)
    setSlug(l2vpn.slug)
    setSlugDirty(true)
    setType(l2vpn.type)
    setIdentifier(l2vpn.identifier != null ? String(l2vpn.identifier) : "")
    setStatusId(l2vpn.status?.id ?? null)
    setImportIds(l2vpn.import_targets.map((t) => t.id))
    setExportIds(l2vpn.export_targets.map((t) => t.id))
    setDescription(l2vpn.description)
    setComments(l2vpn.comments)
    setTagIds(l2vpn.tags.map((t) => t.id))
    setCustomFields(l2vpn.custom_fields ?? {})
    reset()
  }, [l2vpn, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const rts = useQuery({
    queryKey: ["rts-picker"],
    queryFn: () =>
      api<Paginated<RouteTargetMini>>("/api/route-targets/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "l2vpn"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=l2vpn&picker=1"),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: L2VPNWritePayload & {
        custom_fields: Record<string, unknown>
      } = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        type,
        identifier: identifier ? Number(identifier) : null,
        status_id: statusId,
        import_target_ids: importIds,
        export_target_ids: exportIds,
        description: description.trim(),
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<L2VPN>(`/api/l2vpns/${l2vpn!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<L2VPN>("/api/l2vpns/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["l2vpns"] })
      qc.invalidateQueries({ queryKey: ["l2vpn", saved.id] })
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
      className="@container grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="L2VPN" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Name"
                required
                autoFocus={!isEdit}
                value={name}
                onChange={onNameChange}
                error={fieldErrors.name}
              />
              <FormText
                label="Slug"
                hint="auto-derives from name if blank"
                value={slug}
                onChange={(v) => {
                  setSlugDirty(true)
                  setSlug(slugify(v))
                }}
                mono
                error={fieldErrors.slug}
              />
            </div>

            <div className="grid gap-3 @md:grid-cols-2">
              <FormSelect
                label="Type"
                value={type}
                onChange={(v) => setType((v as L2VPNType) ?? "vxlan")}
                options={L2VPN_TYPES}
              />
              <FormText
                label="Identifier"
                hint="optional - VNI / VPN id"
                type="number"
                value={identifier}
                onChange={setIdentifier}
                error={fieldErrors.identifier}
              />
            </div>

            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statuses.data?.results ?? []}
              noneLabel="No status"
              placeholder="Select a status…"
              error={fieldErrors.status_id}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Route targets" card>
            <Field
              label="Import targets"
              hint="RTs whose routes this L2VPN accepts"
              error={fieldErrors.import_target_ids}
            >
              <RtMultiSelect
                options={rts.data?.results ?? []}
                value={importIds}
                onChange={setImportIds}
                placeholder="Add import RT…"
              />
            </Field>
            <Field
              label="Export targets"
              hint="RTs this L2VPN tags its own routes with"
              error={fieldErrors.export_target_ids}
            >
              <RtMultiSelect
                options={rts.data?.results ?? []}
                value={exportIds}
                onChange={setExportIds}
                placeholder="Add export RT…"
              />
            </Field>
          </FormSection>

          <FormSection title="Notes" card>
            <FormText
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
            <FormTextarea
              label="Comments"
              value={comments}
              onChange={setComments}
              error={fieldErrors.comments}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="l2vpn"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create L2VPN"}
      />
    </form>
  )
}
