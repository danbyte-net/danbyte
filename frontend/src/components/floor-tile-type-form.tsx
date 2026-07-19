import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorTileType, FloorTileTypeWritePayload } from "@/lib/api"
import {
  FormCheckbox,
  FormColor,
  FormFooter,
  FormIcon,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface FloorTileTypeFormProps {
  tileType?: FloorTileType
  onSaved: (saved: FloorTileType) => void
  onCancel: () => void
}

export function FloorTileTypeForm({
  tileType,
  onSaved,
  onCancel,
}: FloorTileTypeFormProps) {
  const isEdit = !!tileType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()

  const [name, setName] = useState(tileType?.name ?? "")
  const [color, setColor] = useState(tileType?.color ?? "")
  const [icon, setIcon] = useState(tileType?.icon ?? "")
  const [defaultWidth, setDefaultWidth] = useState(
    String(tileType?.default_width ?? 1)
  )
  const [defaultHeight, setDefaultHeight] = useState(
    String(tileType?.default_height ?? 1)
  )
  const [isZone, setIsZone] = useState(tileType?.is_zone ?? false)
  const [hasFov, setHasFov] = useState(tileType?.has_fov ?? false)
  const [description, setDescription] = useState(tileType?.description ?? "")

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: FloorTileTypeWritePayload = {
        name: name.trim(),
        color,
        icon,
        default_width: Math.max(1, parseInt(defaultWidth, 10) || 1),
        default_height: Math.max(1, parseInt(defaultHeight, 10) || 1),
        is_zone: isZone,
        has_fov: hasFov,
        description,
      }
      if (isEdit)
        return api<FloorTileType>(`/api/floor-tile-types/${tileType.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<FloorTileType>("/api/floor-tile-types/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["floor-tile-types"] })
      qc.invalidateQueries({ queryKey: ["floor-tile-types-picker"] })
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
        placeholder="Rack, Wall, Cooling unit, Camera…"
        error={fieldErrors.name || fieldErrors.slug}
      />
      <FormColor
        label="Color"
        hint="The tile's fill on the canvas"
        value={color}
        onChange={setColor}
        error={fieldErrors.color}
      />
      <FormIcon
        label="Icon"
        hint="Optional — shown in the palette and lists"
        value={icon}
        onChange={setIcon}
        error={fieldErrors.icon}
      />
      <FormRow>
        <FormText
          label="Default width"
          hint="Cells"
          type="number"
          min={1}
          max={512}
          value={defaultWidth}
          onChange={setDefaultWidth}
          error={fieldErrors.default_width}
        />
        <FormText
          label="Default height"
          hint="Cells"
          type="number"
          min={1}
          max={512}
          value={defaultHeight}
          onChange={setDefaultHeight}
          error={fieldErrors.default_height}
        />
      </FormRow>
      <FormCheckbox
        label="Background zone"
        hint="Paints the grid background (hot/cold aisle, security area) — renders under normal tiles, which may sit on top of it"
        checked={isZone}
        onChange={setIsZone}
      />
      <FormCheckbox
        label="Camera field of view"
        hint="Tiles of this type get a direction / angle / reach cone on the canvas"
        checked={hasFov}
        onChange={setHasFov}
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
        submitLabel={isEdit ? "Save changes" : "Create tile type"}
      />
    </form>
  )
}
