import type { DeviceLeds } from "@/lib/led-state"

/**
 * Port covers (docs/dcim/model-packs.md → Port covers): a model's
 * `cover:port:<interface>` meshes - stack blanks, SFP dust plugs - drawn
 * while the port is free and hidden once it is cabled or marked connected.
 * The server decides which (`/api/device-leds/` `covers` / `bay_covers`,
 * api.port_covers); here are the pure parts: no three.js, so they test
 * without a canvas. floorplan3d/port-covers applies them.
 *
 * No payload (a type's own view, a type's rendered faces, a reader without
 * interface view, a poll not yet answered) leaves every cover as authored.
 */

export const PORT_COVER_PREFIX = "cover:port:"

/** `cover:port:StackPort1/1` → `StackPort1/1`; null for any other name. */
export function portCoverName(gltfName: unknown): string | null {
  if (typeof gltfName !== "string" || !gltfName.startsWith(PORT_COVER_PREFIX))
    return null
  const name = gltfName.slice(PORT_COVER_PREFIX.length)
  return name || null
}

/** The covers to hide on one device, as `covers` and `bay_covers` carry
 * them. */
export type DeviceCovers = Pick<DeviceLeds, "covers" | "bay_covers">

/** Whether the cover `name` (in the module at `bay`, null for the
 * chassis') hides on `dev`. */
export function coverHidden(
  dev: DeviceCovers | null | undefined,
  name: string,
  bay: string | null = null
): boolean {
  if (!dev) return false
  const list = bay === null ? dev.covers : dev.bay_covers?.[bay]
  return !!list && list.includes(name)
}

/** A stable key for the covers of a payload entry, so a poll that changed
 * nothing re-applies nothing. */
export function coversKey(dev: DeviceCovers | null | undefined): string {
  if (!dev) return ""
  const parts = [...(dev.covers ?? [])].sort()
  for (const [b, list] of Object.entries(dev.bay_covers ?? {}).sort(
    ([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)
  ))
    for (const n of [...(list ?? [])].sort()) parts.push(`${b}\u0001${n}`)
  return parts.join("\u0000")
}
