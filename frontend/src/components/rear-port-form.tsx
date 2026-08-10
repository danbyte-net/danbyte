import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type RearPort,
  type RearPortWritePayload,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { NameRangeHint } from "@/components/name-range-hint"
import { createEach, expandNameRange } from "@/lib/name-range"
import { usePlanTarget, useSaveObject } from "@/lib/save-object"

export interface RearPortFormProps {
  port?: RearPort
  /** Device this port belongs to (locked — ports are added from a device). */
  deviceId: string
  onSaved: (p: RearPort) => void
  onCancel: () => void
}

export function RearPortForm({
  port,
  deviceId,
  onSaved,
  onCancel,
}: RearPortFormProps) {
  const isEdit = !!port
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const isPlanning = !!usePlanTarget()

  const [name, setName] = useState(port?.name ?? "")
  const [positions, setPositions] = useState(
    port?.positions != null ? String(port.positions) : "1"
  )
  const [type, setType] = useState(port?.type ?? "")
  const [isSplitter, setIsSplitter] = useState(port?.is_splitter ?? false)
  const [description, setDescription] = useState(port?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    port?.tags.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!port) return
    setName(port.name)
    setPositions(String(port.positions))
    setType(port.type)
    setIsSplitter(port.is_splitter ?? false)
    setDescription(port.description ?? "")
    setTagIds(port.tags.map((t) => t.id))
    reset()
  }, [port, reset])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RearPortWritePayload = {
        device_id: deviceId,
        name: name.trim(),
        positions: positions.trim() === "" ? 1 : Number(positions),
        is_splitter: isSplitter,
        type: type.trim(),
        description: description.trim(),
        tag_ids: tagIds,
      }
      if (isEdit)
        return saveObject<RearPort>({
          objectType: "api.rearport",
          endpoint: "/api/rear-ports/",
          id: port!.id,
          payload,
        }).then((saved) => ({ saved, count: 1 }))
      // A [a-b] range in the name fans out — "Rear[1-12]" adds a whole panel
      // row, each port with its own strands. In plan mode saveObject stages one
      // create per expanded name, so a planned range records the whole row.
      const names = expandNameRange(payload.name)
      if (names.length > 1 && isPlanning)
        return saveObject<RearPort>({
          objectType: "api.rearport",
          endpoint: "/api/rear-ports/",
          payload,
          names,
        }).then((saved) => ({ saved, count: names.length }))
      return createEach(names, (n) =>
        saveObject<RearPort>({
          objectType: "api.rearport",
          endpoint: "/api/rear-ports/",
          payload: { ...payload, name: n },
        })
      ).then(({ last, count }) => ({ saved: last, count }))
    },
    onSuccess: ({ saved, count }) => {
      qc.invalidateQueries({ queryKey: ["device-rear-ports", deviceId] })
      qc.invalidateQueries({ queryKey: ["rear-ports-picker", deviceId] })
      toast.success(
        isEdit
          ? `Updated ${saved.name}`
          : count > 1
            ? `Created ${count} rear ports`
            : `Created ${saved.name}`
      )
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
          mono
          placeholder="Rear1"
          hint={isEdit ? undefined : "a [1-12] range adds one port per number"}
          error={fieldErrors.name}
        />
        <FormText
          label="Positions"
          type="number"
          required
          value={positions}
          onChange={setPositions}
          placeholder="1"
          error={fieldErrors.positions}
        />
      </div>
      <NameRangeHint name={name} editing={isEdit} noun="rear ports" />
      <FormText
        label="Type"
        value={type}
        onChange={setType}
        placeholder="8p8c, lc, mpo…"
        error={fieldErrors.type}
      />
      <Field label="Splitter" error={fieldErrors.is_splitter}>
        <FormCheckbox
          label={
            <>
              Optical splitter (PON){" "}
              <span className="text-muted-foreground">
                — every front port carries the input signal
              </span>
            </>
          }
          checked={isSplitter}
          onChange={(v) => {
            setIsSplitter(v)
            if (v) setPositions("1")
          }}
        />
      </Field>
      <FormText
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="Optional"
        error={fieldErrors.description}
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
        submitLabel={isEdit ? "Save changes" : "Create rear port"}
      />
    </form>
  )
}
