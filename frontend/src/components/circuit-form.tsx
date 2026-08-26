import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Circuit,
  type CircuitTypeOption,
  type CircuitWritePayload,
  type Paginated,
  type ProviderOption,
  type Status,
} from "@/lib/api"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

export interface CircuitFormProps {
  circuit?: Circuit
  onSaved: (v: Circuit) => void
  onCancel: () => void
}

export function CircuitForm({ circuit, onSaved, onCancel }: CircuitFormProps) {
  const isEdit = !!circuit
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [cid, setCid] = useState(circuit?.cid ?? "")
  const [providerId, setProviderId] = useState<string | null>(
    circuit?.provider?.id ?? null
  )
  const [typeId, setTypeId] = useState<string | null>(circuit?.type?.id ?? null)
  const [statusId, setStatusId] = useState<string | null>(
    circuit?.status?.id ?? null
  )
  const [installDate, setInstallDate] = useState(circuit?.install_date ?? "")
  const [terminationDate, setTerminationDate] = useState(
    circuit?.termination_date ?? ""
  )
  const [commitRate, setCommitRate] = useState(
    circuit?.commit_rate_kbps != null ? String(circuit.commit_rate_kbps) : ""
  )
  const [description, setDescription] = useState(circuit?.description ?? "")
  const [comments, setComments] = useState(circuit?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    circuit?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    circuit?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!circuit) return
    setCid(circuit.cid)
    setProviderId(circuit.provider?.id ?? null)
    setTypeId(circuit.type?.id ?? null)
    setStatusId(circuit.status?.id ?? null)
    setInstallDate(circuit.install_date ?? "")
    setTerminationDate(circuit.termination_date ?? "")
    setCommitRate(
      circuit.commit_rate_kbps != null ? String(circuit.commit_rate_kbps) : ""
    )
    setDescription(circuit.description)
    setComments(circuit.comments)
    setTagIds(circuit.tags.map((t) => t.id))
    setCustomFields(circuit.custom_fields ?? {})
    reset()
  }, [circuit, reset])

  const providers = useQuery({
    queryKey: ["providers-picker"],
    queryFn: () => api<Paginated<ProviderOption>>("/api/providers/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const types = useQuery({
    queryKey: ["circuit-types-picker"],
    queryFn: () =>
      api<Paginated<CircuitTypeOption>>("/api/circuit-types/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "circuit"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=circuit&picker=1"),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CircuitWritePayload = {
        cid: cid.trim(),
        provider_id: providerId ?? "",
        type_id: typeId,
        status_id: statusId,
        install_date: installDate || null,
        termination_date: terminationDate || null,
        commit_rate_kbps: commitRate ? Number(commitRate) : null,
        description: description.trim(),
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Circuit>({
        objectType: "api.circuit",
        endpoint: "/api/circuits/",
        id: isEdit ? circuit!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["circuits"] })
      qc.invalidateQueries({ queryKey: ["circuit", saved.id] })
      toast.success(isEdit ? `Updated ${saved.cid}` : `Created ${saved.cid}`)
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Circuit" card>
            <FormText
              label="Circuit ID"
              required
              mono
              autoFocus={!isEdit}
              value={cid}
              onChange={setCid}
              error={fieldErrors.cid}
            />

            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statuses.data?.results ?? []}
              placeholder="Select a status…"
              error={fieldErrors.status_id}
            />

            <FormCombobox
              label="Provider"
              required
              value={providerId}
              onChange={setProviderId}
              options={(providers.data?.results ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              placeholder="Select provider"
              searchPlaceholder="Search providers…"
              emptyText="No providers."
              error={fieldErrors.provider_id}
            />

            <FormCombobox
              label="Type"
              hint="optional"
              value={typeId}
              onChange={setTypeId}
              options={(types.data?.results ?? []).map((t) => ({
                value: t.id,
                label: t.name,
                color: t.color,
              }))}
              noneLabel="No type"
              placeholder="No type"
              searchPlaceholder="Search types…"
              emptyText="No types."
              error={fieldErrors.type_id}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Service" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Install date"
                type="text"
                placeholder="YYYY-MM-DD"
                value={installDate}
                onChange={setInstallDate}
                error={fieldErrors.install_date}
              />
              <FormText
                label="Termination date"
                type="text"
                placeholder="YYYY-MM-DD"
                value={terminationDate}
                onChange={setTerminationDate}
                error={fieldErrors.termination_date}
              />
            </div>
            <FormText
              label="Commit rate (kbps)"
              type="number"
              value={commitRate}
              onChange={setCommitRate}
              error={fieldErrors.commit_rate_kbps}
            />
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
        model="circuit"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create circuit"}
      />
    </form>
  )
}
