import { endColours, isApc } from "@/lib/fibre-colours"
import type { RecolourChannel } from "@/lib/fibre-colours"
import { receptacleNames } from "@/lib/port-plugs"

/**
 * What the Pluggables page previews a part in (docs/dcim/pluggables.md →
 * 3D model): a cable type picked by hand, its `FIBRE` / `LC_BODY` /
 * `CABLE` colours by the TIA-598 conventions (lib/fibre-colours), and the
 * empties a cord seats on. Pure, so it tests without a canvas.
 */
export interface CablePreview {
  value: string
  label: string
  /** The cable type it stands for (`smf-os2`), "" for none. */
  cableType: string
  apc: boolean
}

export const CABLE_PREVIEWS: readonly CablePreview[] = [
  { value: "", label: "Neutral", cableType: "", apc: false },
  { value: "os2", label: "OS2", cableType: "smf-os2", apc: false },
  { value: "os2-apc", label: "OS2 APC", cableType: "smf-os2", apc: true },
  { value: "om2", label: "OM2", cableType: "mmf-om2", apc: false },
  { value: "om3", label: "OM3", cableType: "mmf-om3", apc: false },
  { value: "om4", label: "OM4", cableType: "mmf-om4", apc: false },
  { value: "om5", label: "OM5", cableType: "mmf-om5", apc: false },
  { value: "cat6", label: "Cat6", cableType: "cat6", apc: false },
]

/** The preview a part opens with: single-mode for a long-reach optic, OM4
 * for a short-reach one, neutral otherwise. */
export function defaultPreview(part: {
  connector: string
  standard: string
  wavelength_nm: number | null
}): string {
  const c = part.connector.toLowerCase()
  if (c.startsWith("rj45")) return "cat6"
  if (!/^(lc|sc|mpo|mtp)/.test(c)) return ""
  if (part.wavelength_nm != null)
    return part.wavelength_nm >= 1200 ? "os2" : "om4"
  return /-(lr|er|zr|bx|lx)/i.test(part.standard) ? "os2" : "om4"
}

/** The three recolour channels for a preview (`value` of CABLE_PREVIEWS),
 * or for a real cable's type and colour. */
export function previewColours(
  value: string,
  connector = ""
): Record<RecolourChannel, string> {
  const p = CABLE_PREVIEWS.find((x) => x.value === value) ?? CABLE_PREVIEWS[0]
  return endColours({
    color: null,
    cableType: p.cableType,
    apc: p.apc || isApc(connector),
    // A stack cable head's END_BAND shows as an A end.
    end: "a",
  })
}

/** The `port:<connector>` empties to seat a cord of `cordConnector` on, in
 * a part of `partConnector`, best first (lib/port-plugs receptacleNames). */
export function cordSeatNames(
  cordConnector: string,
  partConnector: string
): string[] {
  return receptacleNames({
    cord_part: { url: "", kind: "cord", connector: cordConnector, cable: null },
    transceiver_part: {
      url: "",
      kind: "transceiver",
      connector: partConnector,
    },
  })
}
