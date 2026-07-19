import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type ProviderNetwork,
  type ProviderNetworkWritePayload,
  type ProviderOption,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

export interface ProviderNetworkFormProps {
  network?: ProviderNetwork
  onSaved: (v: ProviderNetwork) => void
  onCancel: () => void
}

export function ProviderNetworkForm({
  network,
  onSaved,
  onCancel,
}: ProviderNetworkFormProps) {
  const isEdit = !!network
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(network?.name ?? "")
  const [providerId, setProviderId] = useState<string | null>(
    network?.provider?.id ?? null
  )
  const [providerError, setProviderError] = useState<string | null>(null)
  const [serviceId, setServiceId] = useState(network?.service_id ?? "")
  const [description, setDescription] = useState(network?.description ?? "")
  const [comments, setComments] = useState(network?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    network?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    network?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!network) return
    setName(network.name)
    setProviderId(network.provider?.id ?? null)
    setProviderError(null)
    setServiceId(network.service_id)
    setDescription(network.description)
    setComments(network.comments)
    setTagIds(network.tags.map((t) => t.id))
    setCustomFields(network.custom_fields ?? {})
    reset()
  }, [network, reset])

  const providers = useQuery({
    queryKey: ["providers-picker"],
    queryFn: () => api<Paginated<ProviderOption>>("/api/providers/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      if (!providerId) throw new Error("Provider is required.")
      const payload: ProviderNetworkWritePayload = {
        name: name.trim(),
        provider_id: providerId,
        service_id: serviceId.trim(),
        description: description.trim(),
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<ProviderNetwork>(`/api/provider-networks/${network!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ProviderNetwork>("/api/provider-networks/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["provider-networks"] })
      qc.invalidateQueries({ queryKey: ["provider-networks-picker"] })
      qc.invalidateQueries({ queryKey: ["provider-network", saved.id] })
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
        if (!providerId) {
          setProviderError("Provider is required.")
          return
        }
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormCombobox
          label="Provider"
          value={providerId}
          onChange={(v) => {
            setProviderId(v)
            if (v) setProviderError(null)
          }}
          options={(providers.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          placeholder="Select provider"
          searchPlaceholder="Search providers…"
          emptyText="No providers."
          error={fieldErrors.provider_id ?? providerError ?? undefined}
        />
      </div>
      <FormText
        label="Service ID"
        hint="optional"
        mono
        value={serviceId}
        onChange={setServiceId}
        error={fieldErrors.service_id}
      />
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
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <CustomFieldInputs
        model="providernetwork"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create provider network"}
      />
    </form>
  )
}
