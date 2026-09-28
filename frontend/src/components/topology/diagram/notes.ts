import type { TopologyViewNote } from "@/lib/api"

/**
 * Notes on a Diagram: free text ("NSP1", "MPLS L3VPN") and icons with a
 * caption ("Internet · DC02" under a cloud). They are annotations - nothing
 * is derived from them and no cable ends on one - so all a note holds is
 * where its centre is, what it says, and how big it is drawn.
 *
 * One list per view (`state.notes`), on the Diagram only. Every edit goes
 * through the page's document, so each is one undo step.
 */

export type NoteKind = TopologyViewNote["kind"]
export type NoteIconName = NonNullable<TopologyViewNote["icon"]>
export type NoteSizeName = NonNullable<TopologyViewNote["size"]>

/** What a note may say: the server's cap. */
export const NOTE_TEXT_MAX = 200
/** How many notes a view keeps: the server's cap. */
export const NOTES_MAX = 500

export const NOTE_ICON_NAMES: readonly NoteIconName[] = [
  "cloud",
  "globe",
  "building",
]
export const NOTE_SIZE_NAMES: readonly NoteSizeName[] = ["s", "m", "l"]

/** A new text note's text, selected so typing replaces it. */
export const NEW_NOTE_TEXT = "Text"

/** How far a new note steps down when another stands on its spot. */
const STEP = 32

/** Text as a note keeps it: line ends normalised, blank space at either
 * end trimmed, capped. */
export function cleanNoteText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trim().slice(0, NOTE_TEXT_MAX)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

/** The notes a map can draw: well formed, with a finite centre, each id
 * once. Anything else (a hand-edited store, a newer kind) is skipped. */
export function readNotes(raw: unknown): TopologyViewNote[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: TopologyViewNote[] = []
  for (const n of raw) {
    if (!isObj(n) || typeof n.id !== "string" || !n.id || seen.has(n.id))
      continue
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
    const icon = NOTE_ICON_NAMES.find((i) => i === n.icon)
    if (n.kind === "icon" ? !icon : n.kind !== "text") continue
    seen.add(n.id)
    out.push(n as unknown as TopologyViewNote)
  }
  return out
}

/** `want`, or `want~2`, `want~3`... - whichever no note has. */
function freeId(notes: readonly TopologyViewNote[], want: string): string {
  const used = new Set(notes.map((n) => n.id))
  let id = want
  for (let k = 2; used.has(id); k++) id = `${want}~${k}`
  return id
}

/**
 * A new note centred at `at`: a text note saying "Text", or an icon
 * without a caption. A note already standing on that spot pushes it down,
 * so adding two in a row never stacks them.
 */
export function newNote(
  notes: readonly TopologyViewNote[],
  id: string,
  what: { kind: "text" } | { kind: "icon"; icon: NoteIconName },
  at: { x: number; y: number }
): TopologyViewNote {
  const x = Math.round(at.x)
  let y = Math.round(at.y)
  const taken = (py: number) =>
    notes.some((n) => Math.abs(n.x - x) < STEP && Math.abs(n.y - py) < STEP)
  for (let i = 0; i < 50 && taken(y); i++) y += STEP
  const base = { id: freeId(notes, id), x, y, size: "m" as const }
  return what.kind === "text"
    ? { ...base, kind: "text", text: NEW_NOTE_TEXT }
    : { ...base, kind: "icon", icon: what.icon }
}

/** One note changed. An undefined value removes that key (no caption, no
 * outline); the same list back when nothing changed. */
export function patchNote(
  notes: readonly TopologyViewNote[],
  id: string,
  patch: Partial<Omit<TopologyViewNote, "id" | "kind">>
): TopologyViewNote[] {
  const i = notes.findIndex((n) => n.id === id)
  if (i < 0) return notes as TopologyViewNote[]
  const was = notes[i] as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...was }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  const keys = Object.keys(out)
  if (
    keys.length === Object.keys(was).length &&
    keys.every((k) => out[k] === was[k])
  )
    return notes as TopologyViewNote[]
  const next = notes.slice()
  next[i] = out as unknown as TopologyViewNote
  return next
}

/** The notes without these; the same list back when none of them was
 * there. */
export function removeNotes(
  notes: readonly TopologyViewNote[],
  ids: readonly string[]
): TopologyViewNote[] {
  const gone = new Set(ids)
  const next = notes.filter((n) => !gone.has(n.id))
  return next.length === notes.length ? (notes as TopologyViewNote[]) : next
}

/** The notes with their centres moved to `at` (rounded, as they are
 * saved); null when none moved. */
export function moveNotes(
  notes: readonly TopologyViewNote[],
  at: ReadonlyMap<string, { x: number; y: number }>
): TopologyViewNote[] | null {
  const next = notes.map((n) => {
    const p = at.get(n.id)
    if (!p) return n
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    return x === n.x && y === n.y ? n : { ...n, x, y }
  })
  return next.some((n, i) => n !== notes[i]) ? next : null
}
