import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  VirtualMachineGroup,
  VirtualMachineGroupWritePayload,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

interface MiniNamed {
  id: string
  name: string
}

const KINDS: { value: VirtualMachineGroup["kind"]; label: string }[] = [
  { value: "other", label: "Group" },
  { value: "vapp", label: "vApp" },
  { value: "pool", label: "Resource pool" },
  { value: "folder", label: "Folder" },
]

export interface VmGroupFormProps {
  group?: VirtualMachineGroup
  /** Pre-select a cluster, e.g. when adding from a cluster page. */
  clusterId?: string
  onSaved: (saved: VirtualMachineGroup) => void
  onCancel: () => void
}

export function VmGroupForm({
  group,
  clusterId: initialCluster,
  onSaved,
  onCancel,
}: VmGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(group?.name ?? "")
  const [clusterId, setClusterId] = useState<string | null>(
    group?.cluster.id ?? initialCluster ?? null
  )
  const [kind, setKind] = useState<VirtualMachineGroup["kind"]>(
    group?.kind ?? "other"
  )
  const [description, setDescription] = useState(group?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    group?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    group?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setClusterId(group.cluster.id)
    setKind(group.kind)
    setDescription(group.description)
    setTagIds(group.tags.map((t) => t.id))
    setCustomFields(group.custom_fields)
    reset()
  }, [group, reset])

  const clusters = useQuery({
    queryKey: ["clusters-picker"],
    queryFn: () => api<Paginated<MiniNamed>>("/api/clusters/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VirtualMachineGroupWritePayload = {
        name: name.trim(),
        cluster_id: clusterId ?? "",
        kind,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<VirtualMachineGroup>({
        objectType: "api.virtualmachinegroup",
        endpoint: "/api/vm-groups/",
        id: isEdit ? group.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vm-groups"] })
      qc.invalidateQueries({ queryKey: ["vm-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["vm-group", saved.id] })
      qc.invalidateQueries({ queryKey: ["embedded-vm-groups"] })
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
      <FormSection title="VM group" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="web-stack"
          error={fieldErrors.name}
        />

        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Cluster"
            required
            value={clusterId}
            onChange={setClusterId}
            options={(clusters.data?.results ?? []).map((c) => ({
              value: c.id,
              label: c.name,
            }))}
            placeholder="Select a cluster…"
            searchPlaceholder="Search clusters…"
            emptyText="No clusters."
            error={fieldErrors.cluster_id}
          />

          <FormSelect
            label="Kind"
            value={kind}
            onChange={(v) => setKind(v as VirtualMachineGroup["kind"])}
            options={KINDS}
            error={fieldErrors.kind}
          />
        </div>

        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="virtualmachinegroup"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
