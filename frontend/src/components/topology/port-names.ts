import type { TopoPort, TopologyPortName } from "@/lib/api"

// The text a port is printed by on the map (#541): its name (the default),
// its label or its description, as the view's Display popover or the
// device's own setting picks. A port whose chosen field is empty prints its
// name. The name stays the port's identity everywhere - handles, anchors,
// hidden lines, the cable's tip - only the printed text changes. Pure.

export type PortNameMode = TopologyPortName
export const PORT_NAME_MODES: readonly PortNameMode[] = [
  "name",
  "label",
  "description",
]

/** `v` when it is a port-name mode, else undefined. */
export const portNameModeOf = (v: unknown): PortNameMode | undefined =>
  typeof v === "string" && (PORT_NAME_MODES as readonly string[]).includes(v)
    ? (v as PortNameMode)
    : undefined

/** A device's mode: its own when it has one, else the view's. */
export function devicePortMode(
  own: unknown,
  view: PortNameMode | undefined
): PortNameMode {
  return portNameModeOf(own) ?? view ?? "name"
}

/** The text one port prints: the chosen field, else its name. */
export function portText(
  p: { name: string; label?: string; description?: string },
  mode: PortNameMode
): string {
  if (mode === "label") return p.label?.trim() || p.name
  if (mode === "description") return p.description?.trim() || p.name
  return p.name
}

/** Port name → printed text, for the ports of one device whose text is not
 * their name (a pass-through row's rear port included). Empty in Name
 * mode. */
export function portTexts(
  ports: readonly TopoPort[] | undefined,
  mode: PortNameMode
): Map<string, string> {
  const out = new Map<string, string>()
  if (mode === "name" || !ports) return out
  for (const p of ports) {
    const t = portText(p, mode)
    if (t !== p.name) out.set(p.name, t)
    if (p.pair) {
      const r = portText(
        {
          name: p.pair,
          label: p.pair_label,
          description: p.pair_description,
        },
        mode
      )
      if (r !== p.pair) out.set(p.pair, r)
    }
  }
  return out
}

/** A port's hover: its name, and the printed text after it when that
 * differs - the full text, which the map may have cut. */
export function portTip(name: string, text?: string | null): string {
  return text && text !== name ? `${name} · ${text}` : name
}
