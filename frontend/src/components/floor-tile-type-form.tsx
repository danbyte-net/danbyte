import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { FloorTileType, FloorTileTypeWritePayload } from "@/lib/api"
import {
  FormCheckbox,
  FormColor,
  FormFooter,
  FormIcon,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

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
  const saveObject = useSaveObject()

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
  const [perforated, setPerforated] = useState(tileType?.perforated ?? false)
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
        perforated,
        description,
      }
      return saveObject<FloorTileType>({
        objectType: "api.floortiletype",
        endpoint: "/api/floor-tile-types/",
        id: isEdit ? tileType!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormSection title="Tile type" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Rack, Wall, Cooling unit, Camera…"
          error={fieldErrors.name || fieldErrors.slug}
        />
        <div className="grid gap-3 @md:grid-cols-2">
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
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormCheckbox
          label="Background zone"
          hint="Paints the grid background (hot/cold aisle, security area) - renders under normal tiles, which may sit on top of it"
          checked={isZone}
          onChange={setIsZone}
        />
        <FormCheckbox
          label="Camera field of view"
          hint="Tiles of this type get a direction / angle / reach cone on the canvas"
          checked={hasFov}
          onChange={setHasFov}
        />
        <FormCheckbox
          label="Perforated floor (3D)"
          hint="Zone tiles of this type render as grate/supply tiles in the 3D room - the cold-aisle read"
          checked={perforated}
          onChange={setPerforated}
        />
      </FormSection>

      <FormSection title="Appearance" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormColor
            label="Color"
            hint="The tile's fill on the canvas"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
          <FormIcon
            label="Icon"
            hint="Shown in the palette and lists"
            value={icon}
            onChange={setIcon}
            error={fieldErrors.icon}
          />
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create tile type"}
      />
    </form>
  )
}
