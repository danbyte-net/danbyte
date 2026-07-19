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
import { Field, FormFooter, FormText, useFieldErrors } from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"

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

  const [name, setName] = useState(port?.name ?? "")
  const [positions, setPositions] = useState(
    port?.positions != null ? String(port.positions) : "1"
  )
  const [type, setType] = useState(port?.type ?? "")
  const [isSplitter, setIsSplitter] = useState(port?.is_splitter ?? false)
  const [tagIds, setTagIds] = useState<number[]>(
    port?.tags.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!port) return
    setName(port.name)
    setPositions(String(port.positions))
    setType(port.type)
    setIsSplitter(port.is_splitter ?? false)
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
        tag_ids: tagIds,
      }
      if (isEdit)
        return api<RearPort>(`/api/rear-ports/${port!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<RearPort>("/api/rear-ports/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-rear-ports", deviceId] })
      qc.invalidateQueries({ queryKey: ["rear-ports-picker", deviceId] })
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
          mono
          placeholder="Rear1"
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
      <FormText
        label="Type"
        value={type}
        onChange={setType}
        placeholder="8p8c, lc, mpo…"
        error={fieldErrors.type}
      />
      <Field label="Splitter" error={fieldErrors.is_splitter}>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            className="ck"
            checked={isSplitter}
            onChange={(e) => {
              setIsSplitter(e.target.checked)
              if (e.target.checked) setPositions("1")
            }}
          />
          <span>
            Optical splitter (PON){" "}
            <span className="text-muted-foreground">
              — every front port carries the input signal
            </span>
          </span>
        </label>
      </Field>
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
