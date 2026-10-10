import type { Device, RackOption } from "@/lib/api"

// A device's place in a rack, as the device form draws it: the units of the
// elevation, and the collision rules of DeviceSerializer.validate - so the
// outline turns red exactly where the server would refuse the device, and
// says why in the server's words.
//
// The rules are the server's: a device with no face collides on both, and
// devices on different faces collide only where one of them is full depth
// (a device with no type counts as full depth, as the elevation draws it).

/** What the unit math reads off a rack. */
export type RackUnits = Pick<
  RackOption,
  "u_height" | "starting_unit" | "desc_units"
>

/** What the collision rules read off a device in the rack. */
export type RackOccupant = Pick<
  Device,
  "id" | "name" | "position" | "face" | "rack_width" | "rack_side" | "u_height"
> & { device_type: { is_full_depth: boolean } | null }

/** How a device mounts: its face ("" for both), for a half-width device
 * the half of the unit it takes, and whether it fills both faces. */
export interface RackMount {
  face: "" | "front" | "rear"
  width: "full" | "half"
  side: "" | "left" | "right"
  fullDepth: boolean
}

/** Whether an occupant fills both faces of its units. */
const isFullDepth = (d: RackOccupant) => d.device_type?.is_full_depth ?? true

/** Whether `d` and a device mounted as `mount` are on opposite faces. */
const across = (d: RackOccupant, mount: RackMount) =>
  Boolean(mount.face && d.face && d.face !== mount.face)

/** A device's place in a rack: its lowest unit and how many it takes. */
export interface RackSpot extends RackMount {
  position: number
  height: number
}

/** The rack's lowest and highest unit. */
export function unitRange(rack: RackUnits): [number, number] {
  return [rack.starting_unit, rack.starting_unit + rack.u_height - 1]
}

/** A unit's row in the elevation, 1 at the top: the highest unit on top, or
 * the lowest when the rack numbers its units downward. */
export function unitRow(rack: RackUnits, unit: number): number {
  return rack.desc_units
    ? unit - rack.starting_unit + 1
    : rack.starting_unit + rack.u_height - unit
}

/** "U21", "U21–U22" - a device's units, as the Position dropdown lists them. */
export function fmtUnits(position: number, height: number): string {
  return height > 1 ? `U${position}–U${position + height - 1}` : `U${position}`
}

/** The device in `unit` that a device mounted as `mount` collides with:
 * one on the same face, on no face, or on the other face when either is full
 * depth, in the same unit - unless both are half-width and in opposite
 * halves. `exclude` leaves out the device being placed. */
export function unitBlocker(
  occupants: RackOccupant[],
  mount: RackMount,
  unit: number,
  exclude?: string | null
): RackOccupant | undefined {
  return occupants.find((d) => {
    if (d.id === exclude || d.position == null) return false
    if (across(d, mount) && !mount.fullDepth && !isFullDepth(d)) return false
    if (
      mount.width === "half" &&
      d.rack_width === "half" &&
      mount.side &&
      d.rack_side &&
      d.rack_side !== mount.side
    )
      return false
    return d.position <= unit && unit < d.position + Math.max(1, d.u_height)
  })
}

/** What the server answers for a device at `spot`: null where it fits; else
 * its message, and the units that collide. */
export function rackClash(
  rack: RackUnits,
  occupants: RackOccupant[],
  spot: RackSpot,
  exclude?: string | null
): { message: string; units: number[] } | null {
  const [first, last] = unitRange(rack)
  const top = spot.position + spot.height - 1
  if (spot.position < first || top > last)
    return {
      message: `Device doesn't fit at U${spot.position} in a ${rack.u_height}U rack.`,
      units: [],
    }
  const units: number[] = []
  for (let u = spot.position; u <= top; u++)
    if (unitBlocker(occupants, spot, u, exclude)) units.push(u)
  // The server names the first device it meets that overlaps, in the order
  // the API lists them (by name).
  const blocker = occupants.find((d) =>
    units.some((u) => unitBlocker([d], spot, u, exclude))
  )
  if (!blocker) return null
  const at = `Overlaps ${blocker.name} at U${blocker.position}`
  let message = `${at}.`
  if (across(blocker, spot))
    message = isFullDepth(blocker)
      ? `${at}, which is full depth.`
      : `${at} on the ${blocker.face}; this device is full depth.`
  return { message, units }
}

/** Where a press on a unit puts a device: at `position`, its lowest unit;
 * on `blocker`, the device in the unit; or `free`, how many units the free
 * run around it has when the device is taller. */
export type RackPlacement =
  | { position: number }
  | { blocker: RackOccupant }
  | { free: number }

/** Where a click on `unit` puts a device `height` units tall mounted as
 * `mount`: the clicked unit becomes its lowest, moved down as little as the
 * free run the unit is in needs to hold it. Refused on a taken unit, or in a
 * run too short. */
export function placeInRack(
  rack: RackUnits,
  occupants: RackOccupant[],
  mount: RackMount & { height: number },
  unit: number,
  exclude?: string | null
): RackPlacement {
  const blocker = unitBlocker(occupants, mount, unit, exclude)
  if (blocker) return { blocker }
  const [first, last] = unitRange(rack)
  const free = (u: number) =>
    u >= first && u <= last && !unitBlocker(occupants, mount, u, exclude)
  let lo = unit
  let hi = unit
  while (free(lo - 1)) lo--
  while (free(hi + 1)) hi++
  if (hi - lo + 1 < mount.height) return { free: hi - lo + 1 }
  return { position: Math.min(unit, hi - mount.height + 1) }
}
