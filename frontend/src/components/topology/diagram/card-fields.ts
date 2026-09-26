import type {
  CheckStatus,
  StatusMini,
  TopoCardIp,
  TopoCardValues,
  TopoNode,
} from "@/lib/api"

// What a Diagram card says under the device name, and which pill it wears.
// The server resolves each device's card lines (device, saved view, role,
// tenant or deployment, default) and sends their values; this only turns
// them into text. Values stand alone where they are unambiguous - an IP
// line is just the address - and carry a short prefix where a bare value
// could be mistaken for another line (a serial number, an out-of-band IP).

type NodeData = TopoNode["data"]

/** The owner's names for the card-line keys, for the settings editor, the
 * legend and tooltips. `cf_<key>` lines use the custom field's label. */
export const CARD_FIELD_LABELS: Readonly<Partial<Record<string, string>>> = {
  status: "Status",
  monitor: "Monitoring",
  primary_ip: "IP",
  secondary_ip: "Secondary IP",
  oob_ip: "OOB IP",
  loopback: "Loopback",
  serial: "Serial",
  asset_tag: "Asset tag",
  device_type: "Device type",
  manufacturer: "Manufacturer",
  platform: "Platform",
  role: "Role",
  site: "Site",
  location: "Location",
  rack: "Rack",
  tags: "Tags",
}

/** Keys that render as the card's pill rather than as a line. */
export const CARD_PILL_KEYS: ReadonlySet<string> = new Set([
  "status",
  "monitor",
])

/** At most this many lines under the name (a list holds up to 8 keys, two
 * of which may be pills). */
export const CARD_MAX_LINES = 6

/** The monitoring states that earn a pill, and their default wording. */
const CHECK_PILL: Partial<Record<CheckStatus, string>> = {
  down: "Down",
  degraded: "Degraded",
}

export interface CardLine {
  key: string
  /** The line's name in the settings (`CARD_FIELD_LABELS`). */
  label: string
  /** What the card shows. */
  text: string
}

export type CardPill =
  | { kind: "check"; status: "down" | "degraded"; text: string }
  | { kind: "status"; status: StatusMini; text: string }

export interface CardContent {
  name: string
  lines: CardLine[]
  /** The pill shown now, if any - at most one. */
  pill: CardPill | null
  /** Every pill text this card's field list can show. The card layout
   * reserves room for the widest, so a monitoring change never resizes a
   * card (and never moves a line). */
  pillSlot: string[]
}

export interface CardContentOptions {
  /** The device's current monitoring state; absent when not monitored. */
  monitor?: CheckStatus | null
  /** Overrides `data.card.fields`, e.g. to preview an edited list. */
  fields?: string[]
  /** Custom-field labels by key (without the `cf_` prefix). */
  cfLabels?: Readonly<Record<string, string>>
  /** The tenant's names for the monitoring states. */
  checkLabels?: Partial<Record<"down" | "degraded", string>>
}

/** A line key's display name. */
export function cardFieldLabel(
  key: string,
  cfLabels?: Readonly<Record<string, string>>
): string {
  if (key.startsWith("cf_")) {
    const k = key.slice(3)
    return cfLabels?.[k] || humanize(k)
  }
  return CARD_FIELD_LABELS[key] ?? humanize(key)
}

function humanize(k: string): string {
  const s = k.replace(/[_-]+/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : k
}

/** A custom field's value as card text, or "" for nothing to show. */
function cfText(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (typeof v === "string") return v.trim()
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : ""
  if (Array.isArray(v)) return v.map(cfText).filter(Boolean).join(", ")
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    for (const k of ["name", "display", "label"]) {
      const s = o[k]
      if (typeof s === "string") return s.trim()
    }
  }
  return ""
}

const ip = (v: TopoCardIp | null | undefined) => v?.address ?? ""

/** One line key's text for a device, or "" when it has no value. */
function lineText(
  key: string,
  data: NodeData,
  cfLabels?: Readonly<Record<string, string>>
): string {
  const v: TopoCardValues = data.card?.values ?? {}
  switch (key) {
    case "primary_ip":
      return ip(v.primary_ip)
    case "secondary_ip":
      return ip(v.secondary_ip)
    case "oob_ip":
      return v.oob_ip ? `OOB ${v.oob_ip.address}` : ""
    case "loopback": {
      const all = (v.loopback ?? []).map((l) => l.address).filter(Boolean)
      if (!all.length) return ""
      return all.length > 1 ? `${all[0]} +${all.length - 1}` : all[0]
    }
    case "serial":
      return v.serial ? `SN ${v.serial}` : ""
    case "asset_tag":
      return v.asset_tag ? `Asset ${v.asset_tag}` : ""
    case "device_type":
      return data.device_type ?? ""
    case "manufacturer":
      return v.manufacturer?.name ?? ""
    case "platform":
      return v.platform?.name ?? ""
    case "role":
      return data.role?.name ?? ""
    case "site":
      return data.site ?? ""
    case "location":
      return data.location ?? ""
    case "rack": {
      const r = v.rack
      if (!r) return ""
      return r.position != null
        ? `Rack ${r.name} · U${r.position}`
        : `Rack ${r.name}`
    }
    case "tags":
      return (v.tags ?? []).map((t) => t.name).join(", ")
  }
  if (key.startsWith("cf_")) {
    const text = cfText(v[key as `cf_${string}`])
    return text ? `${cardFieldLabel(key, cfLabels)}: ${text}` : ""
  }
  return ""
}

/**
 * A device's card: its name, the lines its field list resolves to (empty
 * values skipped, at most `CARD_MAX_LINES`), and its pill.
 *
 * Pill: at most one, and only for a key in the list. `monitor` shows the
 * monitoring pill while the device is down or degraded, and beats
 * `status`, which shows the lifecycle status pill whenever it is listed.
 * An empty list is the name alone.
 */
export function cardContent(
  data: NodeData,
  opts: CardContentOptions = {}
): CardContent {
  const fields = opts.fields ?? data.card?.fields ?? []
  const lines: CardLine[] = []
  for (const key of fields) {
    if (CARD_PILL_KEYS.has(key)) continue
    const text = lineText(key, data, opts.cfLabels).trim()
    if (!text) continue
    lines.push({ key, label: cardFieldLabel(key, opts.cfLabels), text })
    if (lines.length === CARD_MAX_LINES) break
  }

  const wording = (s: "down" | "degraded") =>
    opts.checkLabels?.[s] || CHECK_PILL[s] || s
  const pillSlot: string[] = []
  let pill: CardPill | null = null
  if (fields.includes("monitor")) {
    pillSlot.push(wording("down"), wording("degraded"))
    const m = opts.monitor
    if (m === "down" || m === "degraded")
      pill = { kind: "check", status: m, text: wording(m) }
  }
  const status = data.status_mini
  if (fields.includes("status") && status) {
    pillSlot.push(status.name)
    pill ??= { kind: "status", status, text: status.name }
  }
  return { name: data.name, lines, pill, pillSlot }
}
