import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type ClusterType, type ClusterTypeWritePayload } from "@/lib/api"
import {
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface ClusterTypeFormProps {
  clusterType?: ClusterType
  onSaved: (m: ClusterType) => void
  onCancel: () => void
}

export function ClusterTypeForm({
  clusterType,
  onSaved,
  onCancel,
}: ClusterTypeFormProps) {
  const isEdit = !!clusterType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(clusterType?.name ?? "")
  const [slug, setSlug] = useState(clusterType?.slug ?? "")
  const [description, setDescription] = useState(clusterType?.description ?? "")

  useEffect(() => {
    if (!clusterType) return
    setName(clusterType.name)
    setSlug(clusterType.slug)
    setDescription(clusterType.description)
    reset()
  }, [clusterType, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ClusterTypeWritePayload = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
      }
      if (isEdit)
        return api<ClusterType>(`/api/cluster-types/${clusterType!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ClusterType>("/api/cluster-types/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["cluster-types"] })
      qc.invalidateQueries({ queryKey: ["cluster-types-picker"] })
      qc.invalidateQueries({ queryKey: ["cluster-type", saved.id] })
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
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        placeholder="VMware vSphere"
        error={fieldErrors.name}
      />
      <FormText
        label="Slug"
        hint="auto-derives from name if blank"
        value={slug}
        onChange={setSlug}
        placeholder="vmware-vsphere"
        error={fieldErrors.slug}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cluster type"}
      />
    </form>
  )
}
