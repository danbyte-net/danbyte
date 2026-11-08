import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiAll } from "@/lib/api-all"
import type { LocationOption, Room, RoomWritePayload, Status } from "@/lib/api"
import { invalidateRoomViews } from "@/lib/rooms"
import { useSaveObject } from "@/lib/save-object"
import { useSiteOptions } from "@/lib/use-site-options"
import {
  FormColor,
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

export interface RoomFormProps {
  room?: Room
  /** Pre-pick the site and location on a NEW room ("Add room" on a location). */
  initialSiteId?: string
  initialLocationId?: string
  onSaved: (saved: Room) => void
  onCancel: () => void
}

export function RoomForm({
  room,
  initialSiteId,
  initialLocationId,
  onSaved,
  onCancel,
}: RoomFormProps) {
  const isEdit = !!room
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(room?.name ?? "")
  const [code, setCode] = useState(room?.code ?? "")
  // The site only narrows the location list; a room's site is its location's.
  const [siteId, setSiteId] = useState<string | null>(
    room?.site.id ?? initialSiteId ?? null
  )
  const [locationId, setLocationId] = useState<string | null>(
    room?.location.id ?? initialLocationId ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    room?.status?.id ?? null
  )
  const [color, setColor] = useState(room?.color ?? "")
  const [description, setDescription] = useState(room?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    room?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    room?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!room) return
    setName(room.name)
    setCode(room.code)
    setSiteId(room.site.id)
    setLocationId(room.location.id)
    setStatusId(room.status?.id ?? null)
    setColor(room.color)
    setDescription(room.description)
    setTagIds(room.tags.map((t) => t.id))
    setCustomFields(room.custom_fields)
    reset()
  }, [room, reset])

  const sites = useSiteOptions()
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])

  const statuses = useQuery({
    queryKey: ["statuses", "room"],
    queryFn: () => apiAll<Status>("/api/statuses/?available_to=room&picker=1"),
    staleTime: 5 * 60_000,
  })
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      apiAll<LocationOption>(`/api/locations/?picker=1&site=${siteId}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
  })

  // A new room starts on the status flagged default for rooms - once, so
  // picking "No status" afterwards sticks.
  const defaulted = useRef(false)
  useEffect(() => {
    if (isEdit || defaulted.current || !statuses.data) return
    defaulted.current = true
    const d = statuses.data.results.find((s) => s.default_for.includes("room"))
    if (d) setStatusId(d.id)
  }, [isEdit, statuses.data])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RoomWritePayload = {
        name: name.trim(),
        code: code.trim(),
        location_id: locationId ?? "",
        status_id: statusId,
        color: color || "",
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Room>({
        objectType: "api.room",
        endpoint: "/api/rooms/",
        id: room?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      invalidateRoomViews(qc)
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Room" card>
            <div className="grid gap-3 @md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <FormText
                label="Name"
                required
                autoFocus={!isEdit}
                value={name}
                onChange={setName}
                placeholder="Comms room"
                error={fieldErrors.name}
              />
              <FormText
                label="Code"
                hint="optional"
                value={code}
                onChange={setCode}
                mono
                placeholder="210"
                error={fieldErrors.code}
              />
            </div>

            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statuses.data?.results ?? []}
              error={fieldErrors.status_id}
            />

            <FormCombobox
              label="Site"
              required
              value={siteId}
              onChange={(v) => {
                setSiteId(v)
                setLocationId(null) // locations are per-site
              }}
              disabled={siteLocked}
              options={sites.options.map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              placeholder="Select a site…"
              searchPlaceholder="Search sites…"
              emptyText="No sites."
            />

            <FormCombobox
              label="Location"
              required
              value={locationId}
              onChange={setLocationId}
              options={(locations.data?.results ?? []).map((l) => ({
                value: l.id,
                label: l.name,
              }))}
              placeholder={siteId ? "Select a location…" : "Pick a site first"}
              searchPlaceholder="Search locations…"
              emptyText="No locations in this site."
              disabled={!siteId}
              error={fieldErrors.location_id}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Appearance" card>
            <FormColor
              label="Color"
              value={color}
              onChange={setColor}
              error={fieldErrors.color}
            />
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
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
        model="room"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create room"}
      />
    </form>
  )
}
