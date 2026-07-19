import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type FrontPort,
  type FrontPortWritePayload,
  type Paginated,
  type RearPort,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { useStrandModelling } from "@/components/fiber/use-fiber-palette"

export interface FrontPortFormProps {
  port?: FrontPort
  /** Device this port belongs to (locked — ports are added from a device). */
  deviceId: string
  onSaved: (p: FrontPort) => void
  onCancel: () => void
}

export function FrontPortForm({
  port,
  deviceId,
  onSaved,
  onCancel,
}: FrontPortFormProps) {
  const isEdit = !!port
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(port?.name ?? "")
  const [rearPortId, setRearPortId] = useState<string | null>(
    port?.rear_port.id ?? null
  )
  const [position, setPosition] = useState(
    port?.rear_port_position != null ? String(port.rear_port_position) : "1"
  )
  const [type, setType] = useState(port?.type ?? "")
  const [positions, setPositions] = useState(
    port?.positions != null ? String(port.positions) : "1"
  )
  const [tagIds, setTagIds] = useState<number[]>(
    port?.tags.map((t) => t.id) ?? []
  )
  const { front_port_types, connector_fibers } = useDcimChoices()
  const modelling = useStrandModelling()
  const showFibres = modelling === "accurate"

  useEffect(() => {
    if (!port) return
    setName(port.name)
    setRearPortId(port.rear_port.id)
    setPosition(String(port.rear_port_position))
    setType(port.type)
    setPositions(String(port.positions))
    setTagIds(port.tags.map((t) => t.id))
    reset()
  }, [port, reset])

  // Picking a known connector pre-fills the fibre count (editable after).
  const onTypeChange = (v: string | null) => {
    const next = v ?? ""
    setType(next)
    const fibres = connector_fibers[next]
    if (fibres) setPositions(String(fibres))
  }
  // Keep the current value pickable even if it isn't a standard connector.
  const typeOptions = useMemo(() => {
    const opts = front_port_types.map((c) => ({
      value: c.value,
      label: c.label,
    }))
    if (type && !opts.some((o) => o.value === type))
      opts.unshift({ value: type, label: type })
    return opts
  }, [front_port_types, type])

  const rearPorts = useQuery({
    queryKey: ["rear-ports-picker", deviceId],
    queryFn: () =>
      api<Paginated<RearPort>>(`/api/rear-ports/?device=${deviceId}`),
    staleTime: 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const rearOptions = rearPorts.data?.results ?? []
  const selectedRear = rearOptions.find((r) => r.id === rearPortId)
  // Strand options follow the chosen rear port's position count.
  const positionOptions = useMemo(() => {
    const n = selectedRear?.positions ?? 1
    return Array.from({ length: n }, (_, i) => ({
      value: String(i + 1),
      label: String(i + 1),
    }))
  }, [selectedRear])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: FrontPortWritePayload = {
        device_id: deviceId,
        name: name.trim(),
        rear_port_id: rearPortId ?? "",
        rear_port_position: position.trim() === "" ? 1 : Number(position),
        positions: positions.trim() === "" ? 1 : Number(positions),
        type: type.trim(),
        tag_ids: tagIds,
      }
      if (isEdit)
        return api<FrontPort>(`/api/front-ports/${port!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<FrontPort>("/api/front-ports/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-front-ports", deviceId] })
      // A front port consumes a rear strand — refresh rear views too.
      qc.invalidateQueries({ queryKey: ["device-rear-ports", deviceId] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const noRearPorts = !rearPorts.isLoading && rearOptions.length === 0

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      {noRearPorts && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          Add a rear port first — a front port maps to a rear-port strand.
        </p>
      )}
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        mono
        placeholder="Front1"
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Rear port"
          value={rearPortId}
          onChange={(v) => {
            setRearPortId(v)
            setPosition("1")
          }}
          placeholder="Pick a rear port"
          options={rearOptions.map((r) => ({
            value: r.id,
            label: `${r.name} (${r.positions}p)`,
          }))}
          error={fieldErrors.rear_port_id}
        />
        <FormSelect
          label={showFibres ? "Start strand" : "Strand"}
          value={position}
          onChange={(v) => setPosition(v ?? "1")}
          options={positionOptions}
          error={fieldErrors.rear_port_position}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Type / connector"
          value={type || null}
          onChange={onTypeChange}
          placeholder="8p8c, lc, mpo…"
          options={typeOptions}
          error={fieldErrors.type}
        />
        {showFibres && (
          <FormText
            label="Fibres"
            type="number"
            min={1}
            value={positions}
            onChange={setPositions}
            placeholder="1"
            error={fieldErrors.positions}
            hint="Strands the connector carries (LC-duplex 2, MPO 8–24)."
          />
        )}
      </div>
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
        submitLabel={isEdit ? "Save changes" : "Create front port"}
      />
    </form>
  )
}
