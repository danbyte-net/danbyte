import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type VLANGroup,
  type VLANGroupWritePayload,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

type ClusterPick = { id: string; name: string }

export interface VlanGroupFormProps {
  group?: VLANGroup
  onSaved: (g: VLANGroup) => void
  onCancel: () => void
}

export function VlanGroupForm({
  group,
  onSaved,
  onCancel,
}: VlanGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(group?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(group?.site?.id ?? null)
  const [clusterId, setClusterId] = useState<string | null>(
    group?.cluster?.id ?? null
  )
  const [minVid, setMinVid] = useState<string>(
    group ? String(group.min_vid) : "1"
  )
  const [maxVid, setMaxVid] = useState<string>(
    group ? String(group.max_vid) : "4094"
  )
  const [description, setDescription] = useState(group?.description ?? "")

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setSiteId(group.site?.id ?? null)
    setClusterId(group.cluster?.id ?? null)
    setMinVid(String(group.min_vid))
    setMaxVid(String(group.max_vid))
    setDescription(group.description)
    reset()
  }, [group, reset])

  const sites = useSiteOptions()
  const clusters = useQuery({
    queryKey: ["clusters-picker"],
    queryFn: () => api<Paginated<ClusterPick>>("/api/clusters/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VLANGroupWritePayload = {
        name: name.trim(),
        site_id: siteId,
        cluster_id: clusterId,
        min_vid: Number(minVid),
        max_vid: Number(maxVid),
        description: description.trim(),
      }
      return saveObject<VLANGroup>({
        objectType: "api.vlangroup",
        endpoint: "/api/vlan-groups/",
        id: isEdit ? group!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vlan-groups"] })
      qc.invalidateQueries({ queryKey: ["vlan-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["vlan-group", saved.id] })
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
      <FormSection title="Group" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Campus access VLANs"
          error={fieldErrors.name}
        />

        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Min VID"
            required
            type="number"
            inputMode="numeric"
            min={1}
            max={4094}
            mono
            value={minVid}
            onChange={setMinVid}
            error={fieldErrors.min_vid}
          />
          <FormText
            label="Max VID"
            required
            type="number"
            inputMode="numeric"
            min={1}
            max={4094}
            mono
            value={maxVid}
            onChange={setMaxVid}
            error={fieldErrors.max_vid}
          />
        </div>

        <FormTextarea
          label="Description"
          rows={3}
          value={description}
          onChange={setDescription}
          placeholder="e.g. Access VLANs for the Amsterdam campus"
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Scope" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Site"
            value={siteId}
            onChange={setSiteId}
            options={sites.options.map((s) => ({ value: s.id, label: s.name }))}
            noneLabel="No site"
            placeholder="No site"
            searchPlaceholder="Search sites…"
            emptyText="No sites."
            error={fieldErrors.site_id}
          />
          <FormSelect
            label="Cluster"
            value={clusterId}
            onChange={setClusterId}
            options={(clusters.data?.results ?? []).map((cl) => ({
              value: cl.id,
              label: cl.name,
            }))}
            noneLabel="No cluster"
            placeholder="No cluster"
            error={fieldErrors.cluster_id}
          />
        </div>
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
