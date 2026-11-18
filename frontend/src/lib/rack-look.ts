/**
 * A rack's Look (api.rack_look, docs/dcim/racks.md → Look): what the 3D
 * room builds it as. A rack type carries every field; a rack carries the
 * same fields as overrides, null taking the type's value, and a rack with
 * no type takes `LOOK_DEFAULTS`.
 */

export type RackFrame = "2-post" | "4-post" | "cabinet" | "wall-cabinet"
export type RackDoor =
  "none" | "perforated" | "glass" | "solid" | "split-perforated" | "split-solid"
export type RackHinge = "left" | "right"
export type RackTop = "vented" | "solid" | "fans" | "brush"
export type RackBase = "plinth" | "casters" | "feet"

export interface RackKitMini {
  id: string
  vendor: string
  name: string
  frame: RackFrame
}

/** The Look fields as a rack type stores them. */
export interface RackLookFields {
  frame: RackFrame
  rail_depth_mm: number | null
  front_door: RackDoor
  rear_door: RackDoor
  hinge: RackHinge
  side_panels: boolean
  top: RackTop
  base: RackBase
  /** A named colour (black, grey, white) or `#rrggbb`. */
  colour: string
  kit: RackKitMini | null
  blanking_fill: boolean
}

/** The same fields on a rack: null takes the type's. */
export type RackLookOverrides = {
  [K in keyof RackLookFields]: RackLookFields[K] | null
}

/** The resolved Look the rack API sends (`Rack.look`). */
export interface ResolvedRackLook extends RackLookFields {
  /** The fields not set on the rack itself. */
  inherited: (keyof RackLookFields)[]
}

export const LOOK_KEYS: (keyof RackLookFields)[] = [
  "frame",
  "rail_depth_mm",
  "front_door",
  "rear_door",
  "hinge",
  "side_panels",
  "top",
  "base",
  "colour",
  "kit",
  "blanking_fill",
]

export const LOOK_DEFAULTS: RackLookFields = {
  frame: "cabinet",
  rail_depth_mm: null,
  front_door: "perforated",
  rear_door: "split-perforated",
  hinge: "left",
  side_panels: true,
  top: "vented",
  base: "plinth",
  colour: "black",
  kit: null,
  blanking_fill: false,
}

export const FRAME_OPTIONS: { value: RackFrame; label: string }[] = [
  { value: "cabinet", label: "Cabinet" },
  { value: "4-post", label: "4-post" },
  { value: "2-post", label: "2-post" },
  { value: "wall-cabinet", label: "Wall cabinet" },
]
export const DOOR_OPTIONS: { value: RackDoor; label: string }[] = [
  { value: "none", label: "None" },
  { value: "perforated", label: "Perforated" },
  { value: "glass", label: "Glass" },
  { value: "solid", label: "Solid" },
  { value: "split-perforated", label: "Split perforated" },
  { value: "split-solid", label: "Split solid" },
]
export const HINGE_OPTIONS: { value: RackHinge; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
]
export const TOP_OPTIONS: { value: RackTop; label: string }[] = [
  { value: "vented", label: "Vented" },
  { value: "solid", label: "Solid" },
  { value: "fans", label: "Fans" },
  { value: "brush", label: "Brush" },
]
export const BASE_OPTIONS: { value: RackBase; label: string }[] = [
  { value: "plinth", label: "Plinth" },
  { value: "casters", label: "Casters" },
  { value: "feet", label: "Feet" },
]

/** The named colours, as the drawn rack paints them (api.rack_look.COLOURS). */
export const RACK_COLOURS: Record<string, string> = {
  black: "#1b1c1e",
  grey: "#c9ccce",
  white: "#f2f2f0",
}

/** A stored colour as hex. */
export function colourHex(colour: string | null | undefined): string {
  if (!colour) return RACK_COLOURS.black
  return RACK_COLOURS[colour] ?? colour
}

/** Frames with doors and side panels. */
export function isEnclosed(frame: RackFrame): boolean {
  return frame === "cabinet" || frame === "wall-cabinet"
}

/** A rack's Look: its own value, else its type's, else the default - what
 * the API's `look` holds, worked out client-side for a form's preview. */
export function resolveLook(
  own: Partial<RackLookOverrides> | null | undefined,
  type: Partial<RackLookFields> | null | undefined
): ResolvedRackLook {
  const out = { ...LOOK_DEFAULTS } as Record<string, unknown>
  const inherited: (keyof RackLookFields)[] = []
  for (const k of LOOK_KEYS) {
    const mine = own?.[k]
    if (mine !== null && mine !== undefined && mine !== "") {
      out[k] = mine
      continue
    }
    inherited.push(k)
    const typed = type?.[k]
    if (typed !== null && typed !== undefined && typed !== "") out[k] = typed
  }
  return { ...(out as unknown as RackLookFields), inherited }
}

/** The label of a Look value, for a detail card or an inherit option. */
export function lookLabel(key: keyof RackLookFields, value: unknown): string {
  if (value === null || value === undefined) return "-"
  switch (key) {
    case "frame":
      return (
        FRAME_OPTIONS.find((o) => o.value === value)?.label ?? String(value)
      )
    case "front_door":
    case "rear_door":
      return DOOR_OPTIONS.find((o) => o.value === value)?.label ?? String(value)
    case "hinge":
      return (
        HINGE_OPTIONS.find((o) => o.value === value)?.label ?? String(value)
      )
    case "top":
      return TOP_OPTIONS.find((o) => o.value === value)?.label ?? String(value)
    case "base":
      return BASE_OPTIONS.find((o) => o.value === value)?.label ?? String(value)
    case "side_panels":
    case "blanking_fill":
      return value === true ? "Yes" : "No"
    case "rail_depth_mm":
      return `${String(value)} mm`
    case "colour": {
      const v = String(value)
      return v in RACK_COLOURS ? v[0].toUpperCase() + v.slice(1) : v
    }
    case "kit": {
      const k = value as RackKitMini
      return [k.vendor, k.name].filter(Boolean).join(" ")
    }
  }
}

/** A form's Look state: strings for every field, "" meaning unset (a rack
 * inheriting; on a rack type only rail depth and kit may be blank). */
export interface LookDraft {
  frame: string
  rail_depth_mm: string
  front_door: string
  rear_door: string
  hinge: string
  side_panels: string
  top: string
  base: string
  colour: string
  kit_id: string
  blanking_fill: string
}

const bool = (v: boolean | null | undefined) =>
  v === true ? "yes" : v === false ? "no" : ""

/** A form's draft from the stored fields (a rack's overrides or a type's). */
export function lookDraft(
  src: Partial<RackLookOverrides> | null | undefined
): LookDraft {
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v))
  return {
    frame: s(src?.frame),
    rail_depth_mm: s(src?.rail_depth_mm),
    front_door: s(src?.front_door),
    rear_door: s(src?.rear_door),
    hinge: s(src?.hinge),
    side_panels: bool(src?.side_panels),
    top: s(src?.top),
    base: s(src?.base),
    colour: s(src?.colour),
    kit_id: src?.kit?.id ?? "",
    blanking_fill: bool(src?.blanking_fill),
  }
}

export interface LookPayload {
  frame?: string | null
  rail_depth_mm?: number | null
  front_door?: string | null
  rear_door?: string | null
  hinge?: string | null
  side_panels?: boolean | null
  top?: string | null
  base?: string | null
  colour?: string | null
  kit_id?: string | null
  blanking_fill?: boolean | null
}

/** The write payload of a draft: blanks are null (a rack inherits). */
export function lookPayload(d: LookDraft): LookPayload {
  const s = (v: string) => (v.trim() === "" ? null : v.trim())
  const b = (v: string) => (v === "yes" ? true : v === "no" ? false : null)
  return {
    frame: s(d.frame),
    rail_depth_mm:
      d.rail_depth_mm.trim() === "" ? null : Number(d.rail_depth_mm),
    front_door: s(d.front_door),
    rear_door: s(d.rear_door),
    hinge: s(d.hinge),
    side_panels: b(d.side_panels),
    top: s(d.top),
    base: s(d.base),
    colour: s(d.colour),
    kit_id: s(d.kit_id),
    blanking_fill: b(d.blanking_fill),
  }
}
