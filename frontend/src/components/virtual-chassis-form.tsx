import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  type TagOption,
  type VirtualChassis,
  type VirtualChassisWritePayload,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

const TOPOLOGIES = [
  { value: "ring", label: "Ring" },
  { value: "chain", label: "Chain" },
]

export interface VirtualChassisFormProps {
  item?: VirtualChassis
  onSaved: (v: VirtualChassis) => void
  onCancel: () => void
}

// Create/edit form for a virtual chassis (switch stack). Members join from
// the device side (device edit → Stack membership); the master is set from
// the detail page once members exist.
export function VirtualChassisForm({
  item,
  onSaved,
  onCancel,
}: VirtualChassisFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const [name, setName] = useState(item?.name ?? "")
  const [domain, setDomain] = useState(item?.domain ?? "")
  const [topology, setTopology] = useState<"ring" | "chain">(
    item?.stack_topology ?? "ring"
  )
  const [autoStack, setAutoStack] = useState(!!item?.auto_connect_stack)
  const [autoPower, setAutoPower] = useState(!!item?.auto_connect_power)
  const [description, setDescription] = useState(item?.description ?? "")
  const [comments, setComments] = useState(item?.comments ?? "")
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => apiAll<TagOption>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  useEffect(() => {
    if (!item) return
    setName(item.name)
    setDomain(item.domain)
    setTopology(item.stack_topology ?? "ring")
    setAutoStack(!!item.auto_connect_stack)
    setAutoPower(!!item.auto_connect_power)
    setDescription(item.description)
    setComments(item.comments)
    setCustomFields(item.custom_fields ?? {})
    setTagIds(item.tags.map((t) => t.id))
    reset()
  }, [item, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VirtualChassisWritePayload = {
        name: name.trim(),
        domain: domain.trim(),
        stack_topology: topology,
        auto_connect_stack: autoStack,
        auto_connect_power: autoPower,
        description: description.trim(),
        comments: comments.trim(),
        custom_fields: customFields,
        tag_ids: tagIds,
      }
      return saveObject<VirtualChassis>({
        objectType: "api.virtualchassis",
        endpoint: "/api/virtual-chassis/",
        id: isEdit ? item!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["virtual-chassis"] })
      qc.invalidateQueries({ queryKey: ["virtual-chassis-picker"] })
      if (isEdit)
        qc.invalidateQueries({ queryKey: ["virtual-chassis", saved.id] })
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
      <FormSection title="Virtual chassis" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="stack-fra-01"
            error={fieldErrors.name}
          />
          <FormText
            label="Domain"
            hint="optional"
            value={domain}
            onChange={setDomain}
            mono
            placeholder="stack-domain-1"
            error={fieldErrors.domain}
          />
          <FormSelect
            label="Topology"
            value={topology}
            onChange={(v) => setTopology(v === "chain" ? "chain" : "ring")}
            options={TOPOLOGIES}
            info="How the members are cabled. A ring closes back from the last member to the first; a chain does not. The 3D views draw the stack cables this way when none are recorded."
            error={fieldErrors.stack_topology}
          />
        </div>
        <div className="grid gap-2">
          <FormCheckbox
            label="Auto-connect stack ports"
            checked={autoStack}
            onChange={setAutoStack}
            info="Records the ring of stack ports as cables and keeps it in step with the members. A port with another cable is left alone; editing an auto cable makes it an ordinary one."
          />
          <FormCheckbox
            label="Auto-connect StackPower ports"
            checked={autoPower}
            onChange={setAutoPower}
            info="The same for the StackPower ports, in rings of at most four."
          />
          {(fieldErrors.auto_connect_stack ||
            fieldErrors.auto_connect_power) && (
            <p className="text-xs text-destructive">
              {fieldErrors.auto_connect_stack || fieldErrors.auto_connect_power}
            </p>
          )}
        </div>
      </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTextarea
          label="Comments"
          hint="optional"
          value={comments}
          onChange={setComments}
          error={fieldErrors.comments}
        />
      </FormSection>

      <CustomFieldInputs
        model="virtualchassis"
        value={customFields}
        onChange={setCustomFields}
      />
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create virtual chassis"}
      />
    </form>
  )
}
