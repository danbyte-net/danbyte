import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type Cluster,
  type ClusterWritePayload,
  type Paginated,
  type Status,
} from "@/lib/api"
import {
  FormCombobox,
  QuickAddDialog,
  FormFooter,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

interface MiniNamed {
  id: string
  name: string
}

export interface ClusterFormProps {
  cluster?: Cluster
  onSaved: (saved: Cluster) => void
  onCancel: () => void
}

// Sentinel thrown from mutationFn when a client-side required-field check
// fails — onError swallows it so we don't fire a toast on top of the
// inline field error.
const CLIENT_VALIDATION = "__client_validation__"

export function ClusterForm({ cluster, onSaved, onCancel }: ClusterFormProps) {
  const isEdit = !!cluster
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(cluster?.name ?? "")
  const [typeId, setTypeId] = useState<string | null>(cluster?.type.id ?? null)
  const [groupId, setGroupId] = useState<string | null>(
    cluster?.group?.id ?? null
  )
  const [siteId, setSiteId] = useState<string | null>(cluster?.site?.id ?? null)
  const [statusId, setStatusId] = useState<string | null>(
    cluster?.status?.id ?? null
  )
  const [description, setDescription] = useState(cluster?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    cluster?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    cluster?.custom_fields ?? {}
  )
  // Client-side required-field errors, merged with the DRF field errors.
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!cluster) return
    setName(cluster.name)
    setTypeId(cluster.type.id)
    setGroupId(cluster.group?.id ?? null)
    setSiteId(cluster.site?.id ?? null)
    setStatusId(cluster.status?.id ?? null)
    setDescription(cluster.description)
    setTagIds(cluster.tags.map((t) => t.id))
    setCustomFields(cluster.custom_fields ?? {})
    setClientErrors({})
    reset()
  }, [cluster, reset])

  const types = useQuery({
    queryKey: ["cluster-types-picker"],
    queryFn: () => api<Paginated<MiniNamed>>("/api/cluster-types/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const groups = useQuery({
    queryKey: ["cluster-groups-picker"],
    queryFn: () => api<Paginated<MiniNamed>>("/api/cluster-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const sites = useSiteOptions()
  const statuses = useQuery({
    queryKey: ["statuses", "cluster"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=cluster&picker=1"),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      // Cluster type is required by the backend; guard so we never send an
      // empty type_id.
      if (!typeId) {
        setClientErrors({ type_id: "Pick a cluster type." })
        throw new Error(CLIENT_VALIDATION)
      }
      setClientErrors({})
      const payload: ClusterWritePayload = {
        name: name.trim(),
        type_id: typeId,
        group_id: groupId,
        site_id: siteId,
        status_id: statusId,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Cluster>(`/api/clusters/${cluster!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Cluster>("/api/clusters/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["clusters"] })
      qc.invalidateQueries({ queryKey: ["clusters-picker"] })
      qc.invalidateQueries({ queryKey: ["cluster", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      if ((err as Error).message === CLIENT_VALIDATION) return
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
        placeholder="prod-cluster-01"
        error={fieldErrors.name}
      />

      <FormCombobox
        label="Type"
        hint="required"
        value={typeId}
        onChange={(v) => {
          setTypeId(v)
          setClientErrors((e) => ({ ...e, type_id: "" }))
        }}
        options={(types.data?.results ?? []).map((t) => ({
          value: t.id,
          label: t.name,
        }))}
        placeholder="Select a cluster type…"
        searchPlaceholder="Search types…"
        emptyText="No cluster types."
        error={clientErrors.type_id || fieldErrors.type_id}
        quickAdd={
          <QuickAddDialog
            title="New cluster type"
            endpoint="/api/cluster-types/"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description", type: "textarea" },
            ]}
            onCreated={(t) => {
              qc.invalidateQueries({ queryKey: ["cluster-types-picker"] })
              setTypeId(t.id)
              setClientErrors((e) => ({ ...e, type_id: "" }))
            }}
          />
        }
      />

      <FormCombobox
        label="Group"
        hint="optional"
        value={groupId}
        onChange={setGroupId}
        options={(groups.data?.results ?? []).map((g) => ({
          value: g.id,
          label: g.name,
        }))}
        noneLabel="No group"
        placeholder="Select a cluster group…"
        searchPlaceholder="Search groups…"
        emptyText="No cluster groups."
        error={fieldErrors.group_id}
        quickAdd={
          <QuickAddDialog
            title="New cluster group"
            endpoint="/api/cluster-groups/"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description", type: "textarea" },
            ]}
            onCreated={(g) => {
              qc.invalidateQueries({ queryKey: ["cluster-groups-picker"] })
              setGroupId(g.id)
            }}
          />
        }
      />

      <FormCombobox
        label="Site"
        hint="optional"
        value={siteId}
        onChange={setSiteId}
        options={sites.options.map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        noneLabel="No site"
        placeholder="Select a site…"
        searchPlaceholder="Search sites…"
        emptyText="No sites."
        error={fieldErrors.site_id}
      />

      <FormCombobox
        label="Status"
        value={statusId}
        onChange={setStatusId}
        options={(statuses.data?.results ?? []).map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        noneLabel="No status"
        placeholder="Select a status…"
        error={fieldErrors.status_id}
      />

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="cluster"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cluster"}
      />
    </form>
  )
}
