import { useQuery } from "@tanstack/react-query"

import { apiAll } from "@/lib/api-all"
import type { RoomOption } from "@/lib/api"
import { FormCombobox } from "@/components/forms"

/** The rooms of one location, as `?picker=1` rows. */
export function useRoomOptions(locationId: string | null) {
  return useQuery({
    queryKey: ["rooms-picker", locationId],
    queryFn: () =>
      apiAll<RoomOption>(`/api/rooms/?picker=1&location=${locationId}`),
    enabled: !!locationId,
    staleTime: 5 * 60_000,
  })
}

/**
 * The Room picker on the device, rack and cabinet forms: the rooms of the
 * object's location, each as its colour badge. A room is in one location,
 * so the picker waits for one; the form clears the room when the location
 * changes (the server clears a room left behind too).
 */
export function FormRoomCombobox({
  locationId,
  value,
  onChange,
  error,
}: {
  locationId: string | null
  value: string | null
  onChange: (id: string | null) => void
  error?: string
}) {
  const rooms = useRoomOptions(locationId)
  return (
    <FormCombobox
      label="Room"
      hint="optional · within the location"
      value={value}
      onChange={onChange}
      options={(rooms.data?.results ?? []).map((r) => ({
        value: r.id,
        label: r.name,
        color: r.color || null,
        badge: true,
      }))}
      noneLabel="No room"
      placeholder={locationId ? "Select a room…" : "Pick a location first"}
      searchPlaceholder="Search rooms…"
      emptyText="No rooms in this location."
      disabled={!locationId}
      error={error}
    />
  )
}
