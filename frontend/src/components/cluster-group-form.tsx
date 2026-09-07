import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { type ClusterGroup, type ClusterGroupWritePayload } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface ClusterGroupFormProps {
  clusterGroup?: ClusterGroup
  onSaved: (m: ClusterGroup) => void
  onCancel: () => void
}

export function ClusterGroupForm({
  clusterGroup,
  onSaved,
  onCancel,
}: ClusterGroupFormProps) {
  const isEdit = !!clusterGroup
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(clusterGroup?.name ?? "")
  const [slug, setSlug] = useState(clusterGroup?.slug ?? "")
  const [description, setDescription] = useState(
    clusterGroup?.description ?? ""
  )

  useEffect(() => {
    if (!clusterGroup) return
    setName(clusterGroup.name)
    setSlug(clusterGroup.slug)
    setDescription(clusterGroup.description)
    reset()
  }, [clusterGroup, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ClusterGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      }
      return saveObject<ClusterGroup>({
        objectType: "api.clustergroup",
        endpoint: "/api/cluster-groups/",
        id: isEdit ? clusterGroup!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["cluster-groups"] })
      qc.invalidateQueries({ queryKey: ["cluster-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["cluster-group", saved.id] })
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
      <FormSection title="Cluster group" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="Production"
            error={fieldErrors.name}
          />
          <FormText
            label="Slug"
            hint="auto-derives from name if blank"
            value={slug}
            onChange={setSlug}
            mono
            placeholder="production"
            error={fieldErrors.slug}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cluster group"}
      />
    </form>
  )
}
