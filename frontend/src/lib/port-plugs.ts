import type { DeviceLeds } from "@/lib/led-state"

/**
 * Plugs in cabled ports (docs/dcim/model-packs.md → Accessory types): the
 * server picks, per cabled port on a device's drawn model, the accessory
 * type that sits in it - an RJ45 plug, an SFP with its LC connector, a DAC
 * head, a cord plug - and names it in `/api/device-leds/` `plugs`
 * (api.port_plugs). Here are the pure parts: no three.js, so they test
 * without a canvas. floorplan3d/port-plugs seats them.
 */

/** One part to seat: at the model's `port:<port>` anchor (in the module at
 * `bay`, null for the chassis'), `name` the device's port it stands for,
 * its model at `url`, its cable's colour or null. */
export interface PortPlug {
  port: string
  bay: string | null
  name: string
  url: string
  color: string | null
  /** A cable is in the port. A port listed only for its transceiver record
   * is not: its part draws without its `plug` child, and a one-piece part
   * not at all (export spec §13). Absent reads as cabled. */
  cabled?: boolean
  /** The transceiver recorded in the port, when the reader may view it. */
  transceiver?: PortTransceiver | null
}

/** A port's recorded transceiver, for its hover card. */
export interface PortTransceiver {
  part_id: string
  serial: string
}

/** The cable colour a plug takes when its cable names none: a neutral
 * patch-cord grey. */
export const PLUG_DEFAULT_COLOR = "#9ca3af"

/** Materials a part recolours from its cable (export spec §13). */
export const RECOLOURED_MATERIALS: ReadonlySet<string> = new Set([
  "CABLE",
  "FIBRE",
])

const HEX = /^#[0-9a-f]{6}$/i

/** The colour a plug's cable parts take. */
export function plugColor(color: string | null | undefined): string {
  return color && HEX.test(color) ? color.toLowerCase() : PLUG_DEFAULT_COLOR
}

/** The plugs of a payload entry (none when it carries none). */
export function plugsOf(
  dev: Pick<DeviceLeds, "plugs"> | null | undefined
): readonly PortPlug[] {
  return dev?.plugs ?? []
}

/** A stable key for a device's plugs, so a poll that changed nothing
 * re-seats nothing. */
export function plugsKey(dev: Pick<DeviceLeds, "plugs"> | null | undefined) {
  return plugsOf(dev)
    .map(
      (p) =>
        `${p.bay ?? ""}\u0001${p.port}\u0001${p.url}\u0001${p.color ?? ""}\u0001${isCabled(p) ? 1 : 0}`
    )
    .sort()
    .join("\u0000")
}

/** The names of the device's ports a plug sits in - the port markers make
 * their pick reach over the plug. */
export function pluggedNames(
  dev: Pick<DeviceLeds, "plugs"> | null | undefined
): ReadonlySet<string> {
  return new Set(plugsOf(dev).map((p) => p.name))
}

/** The plugs by model URL - one instanced draw per part's mesh. */
export function plugsByUrl(
  plugs: readonly PortPlug[]
): Map<string, PortPlug[]> {
  const out = new Map<string, PortPlug[]>()
  for (const p of plugs) {
    const list = out.get(p.url)
    if (list) list.push(p)
    else out.set(p.url, [p])
  }
  return out
}

/** Whether a plug's port has a cable in it (an older payload says nothing:
 * cabled). */
export function isCabled(p: Pick<PortPlug, "cabled">): boolean {
  return p.cabled !== false
}

/** The plugs by model URL and cabled-ness - one instanced draw per part's
 * mesh, the uncabled ones without the part's `plug` child. */
export function plugGroups(
  plugs: readonly PortPlug[]
): { url: string; cabled: boolean; plugs: PortPlug[] }[] {
  const out = new Map<
    string,
    { url: string; cabled: boolean; plugs: PortPlug[] }
  >()
  for (const p of plugs) {
    const cabled = isCabled(p)
    const key = `${p.url}\u0001${cabled ? 1 : 0}`
    const g = out.get(key)
    if (g) g.plugs.push(p)
    else out.set(key, { url: p.url, cabled, plugs: [p] })
  }
  return [...out.values()]
}

/** A part's node named `plug` (Blender may suffix a copy `plug.001`). */
export const PLUG_NODE = /^plug(\.?\d+)?$/i

/** The meshes of a part to draw in a port: all of them when cabled; else
 * the transceiver body without its `plug` child - and nothing for a
 * one-piece part (a DAC, a generic plug), which has no `plug` child. */
export function shownMeshes<T extends { inPlug: boolean }>(
  meshes: readonly T[],
  cabled: boolean
): T[] {
  if (cabled) return [...meshes]
  if (!meshes.some((m) => m.inPlug)) return []
  return meshes.filter((m) => !m.inPlug)
}

/** The recorded transceivers by the device's port name, for the hover
 * cards. */
export function portTransceivers(
  dev: Pick<DeviceLeds, "plugs"> | null | undefined
): ReadonlyMap<string, PortTransceiver> {
  const out = new Map<string, PortTransceiver>()
  for (const p of plugsOf(dev))
    if (p.transceiver) out.set(p.name, p.transceiver)
  return out
}
