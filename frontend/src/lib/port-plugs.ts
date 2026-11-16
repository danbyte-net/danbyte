import type { DeviceLeds } from "@/lib/led-state"
import { endColours, isApc, NEUTRAL } from "@/lib/fibre-colours"
import type { RecolourChannel } from "@/lib/fibre-colours"

/**
 * Parts in the ports of a 3D model (docs/dcim/model-packs.md → Accessory
 * types, export spec §13 v1.9): the server picks, per port in use on a
 * device's drawn model, up to two stacked parts - a transceiver in the
 * cage and the cord plugged into it (an LC duplex, an MPO trunk, an RJ45
 * plug), or a part that takes the port alone (an RJ45 plug in a jack, an
 * LC cord in a panel port, a DAC head, a power cord) - and names them in
 * `/api/device-leds/` `plugs` (api.port_plugs). Here are the pure parts:
 * no three.js, so they test without a canvas. floorplan3d/port-plugs seats
 * them.
 */

/** A part's model and what it is. */
export interface PlugPart {
  url: string
  kind: string
  /** The connector it takes or ends in: `lc`, `mpo`, `rj45`, `dac`… */
  connector: string
}

/** How a cord's run is drawn from its `cable` empty (the pack's
 * `cable:` block). Sizes in mm. */
export interface CordCable {
  profile: "zipcord" | "round"
  jacket_mm: number
  pitch_mm: number | null
  min_bend_mm: number | null
}

export interface CordPart extends PlugPart {
  cable: CordCable | null
}

/** One port's parts: at the model's `port:<port>` anchor (in the module at
 * `bay`, null for the chassis'), `name` the device's port it stands for. */
export interface PortPlug {
  port: string
  bay: string | null
  name: string
  /** The port's type (`10gbase-x-sfpp`, `lc-apc-duplex`). */
  port_type?: string
  /** A cable is in the port (or it is marked connected). */
  cabled?: boolean
  /** The cable's colour, or null. */
  color: string | null
  /** The cable's type (`smf-os2`), "" when unknown or not viewable. */
  cable_type?: string
  /** The transceiver recorded in the port, when the reader may view it. */
  transceiver?: PortTransceiver | null
  /** In the cage, at the port's anchor. */
  transceiver_part: PlugPart | null
  /** At the transceiver's `port:<connector>` empty, else at the port's
   * anchor. */
  cord_part: CordPart | null
}

/** A port's recorded transceiver, for its hover card. */
export interface PortTransceiver {
  part_id: string
  serial: string
}

/** The cable colour a plug takes when its cable names none. */
export const PLUG_DEFAULT_COLOR = NEUTRAL

/** Materials a part recolours from its cable (export spec §13). */
export const RECOLOURED_MATERIALS: ReadonlySet<string> = new Set([
  "CABLE",
  "FIBRE",
  "LC_BODY",
])

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
    .map((p) =>
      [
        p.bay ?? "",
        p.port,
        p.name,
        p.transceiver_part?.url ?? "",
        p.transceiver_part?.connector ?? "",
        p.cord_part?.url ?? "",
        p.cord_part?.connector ?? "",
        JSON.stringify(p.cord_part?.cable ?? null),
        p.color ?? "",
        p.cable_type ?? "",
        p.port_type ?? "",
      ].join("\u0001")
    )
    .sort()
    .join("\u0000")
}

/** The names of the device's ports a part sits in - the port markers make
 * their pick reach over it. */
export function pluggedNames(
  dev: Pick<DeviceLeds, "plugs"> | null | undefined
): ReadonlySet<string> {
  return new Set(
    plugsOf(dev)
      .filter((p) => p.transceiver_part || p.cord_part)
      .map((p) => p.name)
  )
}

/** The three recolour channels' colours for a port's parts. */
export function plugColours(
  p: Pick<PortPlug, "color" | "cable_type" | "port_type" | "cord_part">
): Record<RecolourChannel, string> {
  return endColours({
    color: p.color,
    cableType: p.cable_type,
    apc: isApc(p.port_type, p.cord_part?.connector),
  })
}

/** The connector names to look for as a `port:<connector>` empty in a
 * transceiver's model, best first: the cord's, then the transceiver's
 * (`mpo-12` also as `mpo`). */
export function receptacleNames(
  p: Pick<PortPlug, "cord_part" | "transceiver_part">
): string[] {
  const out: string[] = []
  const add = (n: string) => {
    if (n && !out.includes(n)) out.push(n)
  }
  for (const c of [p.cord_part?.connector, p.transceiver_part?.connector]) {
    const n = (c ?? "").trim().toLowerCase()
    add(n)
    add(n.replace(/-\d+$/, ""))
  }
  return out
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

/** Every part URL a set of plugs needs loaded. */
export function plugUrls(plugs: readonly PortPlug[]): string[] {
  const out = new Set<string>()
  for (const p of plugs) {
    if (p.transceiver_part) out.add(p.transceiver_part.url)
    if (p.cord_part) out.add(p.cord_part.url)
  }
  return [...out]
}
