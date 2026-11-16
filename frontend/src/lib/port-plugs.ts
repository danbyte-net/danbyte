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
      (p) => `${p.bay ?? ""}\u0001${p.port}\u0001${p.url}\u0001${p.color ?? ""}`
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
