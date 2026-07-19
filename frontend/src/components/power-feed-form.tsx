import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PowerFeed,
  type PowerFeedType,
  type PowerFeedWritePayload,
  type PowerPanelOption,
  type PowerPhase,
  type PowerSupply,
  type RackOption,
  type Status,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

const TYPES: { value: PowerFeedType; label: string }[] = [
  { value: "primary", label: "Primary" },
  { value: "redundant", label: "Redundant" },
]
const SUPPLIES: { value: PowerSupply; label: string }[] = [
  { value: "ac", label: "AC" },
  { value: "dc", label: "DC" },
]
const PHASES: { value: PowerPhase; label: string }[] = [
  { value: "single", label: "Single phase" },
  { value: "three", label: "Three phase" },
]

export interface PowerFeedFormProps {
  feed?: PowerFeed
  onSaved: (v: PowerFeed) => void
  onCancel: () => void
}

export function PowerFeedForm({ feed, onSaved, onCancel }: PowerFeedFormProps) {
  const isEdit = !!feed
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(feed?.name ?? "")
  const [panelId, setPanelId] = useState<string | null>(
    feed?.power_panel?.id ?? null
  )
  const [rackId, setRackId] = useState<string | null>(feed?.rack?.id ?? null)
  const [statusId, setStatusId] = useState<string | null>(
    feed?.status?.id ?? null
  )
  const [type, setType] = useState<PowerFeedType>(feed?.type ?? "primary")
  const [supply, setSupply] = useState<PowerSupply>(feed?.supply ?? "ac")
  const [phase, setPhase] = useState<PowerPhase>(feed?.phase ?? "single")
  const [voltage, setVoltage] = useState(
    feed?.voltage != null ? String(feed.voltage) : ""
  )
  const [amperage, setAmperage] = useState(
    feed?.amperage != null ? String(feed.amperage) : ""
  )
  const [maxUtil, setMaxUtil] = useState(
    feed?.max_utilization != null ? String(feed.max_utilization) : "80"
  )
  const [comments, setComments] = useState(feed?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    feed?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    feed?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!feed) return
    setName(feed.name)
    setPanelId(feed.power_panel?.id ?? null)
    setRackId(feed.rack?.id ?? null)
    setStatusId(feed.status?.id ?? null)
    setType(feed.type)
    setSupply(feed.supply)
    setPhase(feed.phase)
    setVoltage(feed.voltage != null ? String(feed.voltage) : "")
    setAmperage(feed.amperage != null ? String(feed.amperage) : "")
    setMaxUtil(
      feed.max_utilization != null ? String(feed.max_utilization) : "80"
    )
    setComments(feed.comments)
    setTagIds(feed.tags.map((t) => t.id))
    setCustomFields(feed.custom_fields ?? {})
    reset()
  }, [feed, reset])

  const panels = useQuery({
    queryKey: ["power-panels-picker"],
    queryFn: () =>
      api<Paginated<PowerPanelOption>>("/api/power-panels/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const racks = useQuery({
    queryKey: ["racks-picker"],
    queryFn: () => api<Paginated<RackOption>>("/api/racks/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "powerfeed"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=powerfeed&picker=1"),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: PowerFeedWritePayload = {
        name: name.trim(),
        power_panel_id: panelId ?? "",
        rack_id: rackId,
        status_id: statusId,
        type,
        supply,
        phase,
        voltage: voltage ? Number(voltage) : null,
        amperage: amperage ? Number(amperage) : null,
        max_utilization: maxUtil ? Number(maxUtil) : 80,
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<PowerFeed>(`/api/power-feeds/${feed!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<PowerFeed>("/api/power-feeds/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["power-feeds"] })
      qc.invalidateQueries({ queryKey: ["power-feed", saved.id] })
      qc.invalidateQueries({ queryKey: ["power-panels"] })
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
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Power panel"
          value={panelId}
          onChange={setPanelId}
          options={(panels.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.name,
          }))}
          placeholder="Select panel"
          searchPlaceholder="Search panels…"
          emptyText="No panels."
          error={fieldErrors.power_panel_id}
        />
        <FormCombobox
          label="Rack"
          hint="optional"
          value={rackId}
          onChange={setRackId}
          options={(racks.data?.results ?? []).map((r) => ({
            value: r.id,
            label: r.name,
          }))}
          noneLabel="No rack"
          placeholder="No rack"
          searchPlaceholder="Search racks…"
          emptyText="No racks."
          error={fieldErrors.rack_id}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <FormSelect
          label="Type"
          value={type}
          onChange={(v) => setType((v as PowerFeedType) ?? "primary")}
          options={TYPES}
        />
        <FormSelect
          label="Supply"
          value={supply}
          onChange={(v) => setSupply((v as PowerSupply) ?? "ac")}
          options={SUPPLIES}
        />
        <FormSelect
          label="Phase"
          value={phase}
          onChange={(v) => setPhase((v as PowerPhase) ?? "single")}
          options={PHASES}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <FormText
          label="Voltage (V)"
          type="number"
          value={voltage}
          onChange={setVoltage}
          error={fieldErrors.voltage}
        />
        <FormText
          label="Amperage (A)"
          type="number"
          value={amperage}
          onChange={setAmperage}
          error={fieldErrors.amperage}
        />
        <FormText
          label="Max utilisation (%)"
          type="number"
          value={maxUtil}
          onChange={setMaxUtil}
          error={fieldErrors.max_utilization}
        />
      </div>

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
        model="powerfeed"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create feed"}
      />
    </form>
  )
}
