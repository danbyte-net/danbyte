import { useCallback, useEffect, useReducer, useRef } from "react"
import type { RefObject } from "react"
import { useBlocker } from "@tanstack/react-router"
import type { ShouldBlockFn } from "@tanstack/react-router"

import { ApiError } from "@/lib/api"
import type {
  TopologyLinkOverride,
  TopologyPositionStyle,
  TopologyViewFilters,
  TopologyViewNote,
  TopologyViewSaved,
  TopologyViewState,
} from "@/lib/api"
import { NO_TOPO_HIDDEN, readTopoHidden } from "./hidden"
import type { TopoHidden } from "./hidden"
import { viewPositions } from "./view-positions"
import type { PosMap, Zone } from "./view-positions"

/**
 * The editable half of a topology map: everything a saved view stores that
 * is not in the URL. Display settings and filters ride on the URL (a link
 * reproduces them, Back undoes them); what lives here is what only Save or
 * this browser keeps - the arrangement, zones and bands, hidden objects,
 * per-link and per-card overrides and notes.
 *
 * Edits go through `docReducer`, so every change is one undoable step, and
 * the page can tell "changed since it was opened or saved" (`dirty`) from
 * "different from the defaults".
 */
export type DocStyle = TopologyPositionStyle
export type DocPositions = Partial<Record<DocStyle, PosMap>>
export type DocZones = Partial<Record<DocStyle, Zone[]>>
export type NodeOverride = NonNullable<TopologyViewState["nodes"]>[string]

export interface ViewDocument {
  /** One arrangement per view style. No entry = that style lays itself out. */
  positions: DocPositions
  /** Zones and bands, per view style like the arrangements. */
  zones: DocZones
  /** `state.filters` as saved - the URL overrides it on Save. Carries the
   * keys the URL does not (the Diagram tab's display, card lines). */
  filters: TopologyViewFilters
  /** Per-link overrides keyed by the sorted device pair `"<uuid>|<uuid>"`. */
  links: Record<string, TopologyLinkOverride>
  /** Per-card overrides keyed by device id. */
  nodes: Record<string, NodeOverride>
  notes: TopologyViewNote[]
  hidden: TopoHidden
  /** The hand-picked device set; null = the filters decide. */
  devices: string[] | null
  /** Top-level state keys this version does not model, written back as
   * they came so an older page never drops a newer view's data. */
  extra: Record<string, unknown>
}

export const DOC_STYLES: readonly DocStyle[] = [
  "stencil",
  "hierarchy",
  "flat",
  "diagram",
]

/** Undo depth. A drag is one step, however long it took. */
export const HISTORY_LIMIT = 100

const MODELLED = new Set([
  "filters",
  "positions_by_style",
  "positions",
  "zones_by_style",
  "hidden",
  "links",
  "nodes",
  "notes",
])

export function emptyDocument(over: Partial<ViewDocument> = {}): ViewDocument {
  return {
    positions: {},
    zones: {},
    filters: {},
    links: {},
    nodes: {},
    notes: [],
    hidden: NO_TOPO_HIDDEN,
    devices: null,
    extra: {},
    ...over,
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v)

/** A saved view as a document. `styleOf` sanitises the view style a
 * pre-split view kept its single arrangement under. */
export function docFromView(
  v: TopologyViewSaved,
  styleOf: (raw: unknown) => string
): ViewDocument {
  return docFromState(v.state, styleOf)
}

/** A saved view's `state` as a document - also how this browser keeps the
 * default map, so it holds everything a view does. */
export function docFromState(
  state: unknown,
  styleOf: (raw: unknown) => string
): ViewDocument {
  const s: TopologyViewState = isObj(state) ? state : {}
  const noFilters: TopologyViewFilters = {}
  const { devices, ...filters } = isObj(s.filters) ? s.filters : noFilters
  const zones: DocZones = {}
  if (isObj(s.zones_by_style))
    for (const style of DOC_STYLES) {
      const list = (s.zones_by_style as Record<string, unknown>)[style]
      if (Array.isArray(list)) zones[style] = list as Zone[]
    }
  const extra: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(s)) if (!MODELLED.has(k)) extra[k] = val
  return {
    positions: viewPositions({ state: s }, styleOf),
    zones,
    filters,
    links: isObj(s.links) ? s.links : {},
    nodes: isObj(s.nodes) ? s.nodes : {},
    notes: Array.isArray(s.notes) ? s.notes : [],
    hidden: readTopoHidden(s.hidden),
    devices: Array.isArray(devices)
      ? devices.filter((x): x is string => typeof x === "string")
      : null,
    extra,
  }
}

/**
 * The document as a saved view's `state`.
 *
 * Positions are written as the user owns them: a drag snapshots the whole
 * style, Re-layout deletes it. The live canvas is deliberately not captured
 * here - it would pin a fresh auto layout, and a pinned auto layout replays
 * stale coordinates forever once the device set changes. No entry = that
 * style keeps laying itself out.
 */
export function toViewState(
  doc: ViewDocument,
  opts: {
    /** The URL's settings, which win over the saved ones. */
    filters?: Record<string, unknown>
    /** The device set on screen, when the page owns it. */
    devices?: string[] | null
    /** The style on screen, for the legacy single-map `positions`. */
    style?: string
  } = {}
): TopologyViewState {
  const devices = opts.devices !== undefined ? opts.devices : doc.devices
  const filters: TopologyViewFilters = { ...doc.filters, ...opts.filters }
  delete filters.devices
  if (devices) filters.devices = devices
  const state: TopologyViewState = {
    ...doc.extra,
    filters,
    positions_by_style: doc.positions,
    // Kept in step for anything still reading the single-map field.
    positions: (opts.style && doc.positions[opts.style as DocStyle]) || {},
    zones_by_style: doc.zones,
    hidden: doc.hidden,
  }
  if (Object.keys(doc.links).length) state.links = doc.links
  if (Object.keys(doc.nodes).length) state.nodes = doc.nodes
  if (doc.notes.length) state.notes = doc.notes
  return state
}

/** The default map as this browser stores it: a saved view's `state`,
 * without a device set (the default map has none). */
export function storedDefaultMap(doc: ViewDocument): string {
  return JSON.stringify(toViewState({ ...doc, devices: null, extra: {} }))
}

/** A stored default map as a document; null when there is none or it
 * cannot be read, so the caller falls back to the older keys. */
export function readDefaultMap(
  raw: string | null,
  styleOf: (raw: unknown) => string
): ViewDocument | null {
  if (!raw) return null
  let state: unknown
  try {
    state = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObj(state)) return null
  return { ...docFromState(state, styleOf), devices: null, extra: {} }
}

export type DocAction =
  /** A style's arrangement after a drag (the full snapshot of the canvas),
   * or null for Re-layout. `seen` lists the node ids the query returned:
   * an entry for any other id - a card this user may not view - is kept,
   * so saving a shared view never drops somebody else's arrangement. */
  | {
      type: "setPositions"
      style: DocStyle
      positions: PosMap | null
      seen?: readonly string[]
    }
  /** Every style's arrangement is stale - the map holds different devices. */
  | { type: "clearPositions" }
  /** Devices join the hand-picked set; `place` pins them in `style`. */
  | {
      type: "addDevices"
      ids: readonly string[]
      style?: DocStyle
      place?: PosMap
    }
  /** Devices leave the set, and everything that belonged to them goes. */
  | { type: "removeDevices"; ids: readonly string[] }
  | { type: "setRegions"; style: DocStyle; regions: Zone[] }
  | { type: "setLink"; key: string; value: TopologyLinkOverride | null }
  | { type: "setNode"; id: string; value: NodeOverride | null }
  | { type: "setNotes"; notes: TopologyViewNote[] }
  | { type: "setHidden"; hidden: TopoHidden }
  /** Merge into the saved filters; an undefined value removes the key. */
  | { type: "setDisplay"; patch: Record<string, unknown> }
  /** The whole document at once - still one undoable step. */
  | { type: "replace"; doc: ViewDocument }

const same = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

const devNode = (id: string) => `dev:${id}`

function withStyle<T>(
  all: Partial<Record<DocStyle, T>>,
  style: DocStyle,
  value: T | null
): Partial<Record<DocStyle, T>> {
  const next = { ...all }
  if (value === null) delete next[style]
  else next[style] = value
  return next
}

/** Pure: the document after one action. Returns `doc` itself when nothing
 * changed, so a no-op never becomes an undo step or a dirty flag. */
export function docReducer(doc: ViewDocument, a: DocAction): ViewDocument {
  switch (a.type) {
    case "setPositions": {
      const prev = doc.positions[a.style]
      let next: PosMap | null = a.positions ? { ...a.positions } : null
      if (prev && a.seen) {
        const seen = new Set(a.seen)
        const kept = Object.entries(prev).filter(([id]) => !seen.has(id))
        if (kept.length) next = { ...Object.fromEntries(kept), ...next }
      }
      if (next && !Object.keys(next).length) next = null
      if (same(prev ?? null, next)) return doc
      return { ...doc, positions: withStyle(doc.positions, a.style, next) }
    }
    case "clearPositions":
      return Object.keys(doc.positions).length ? { ...doc, positions: {} } : doc
    case "addDevices": {
      const have = new Set(doc.devices ?? [])
      const fresh = a.ids.filter((id) => !have.has(id))
      let positions = doc.positions
      if (a.style && a.place && Object.keys(a.place).length) {
        const cur = positions[a.style] ?? {}
        const merged = { ...cur, ...a.place }
        if (!same(cur, merged))
          positions = withStyle(positions, a.style, merged)
      }
      if (!fresh.length && positions === doc.positions) return doc
      return {
        ...doc,
        devices: fresh.length
          ? [...(doc.devices ?? []), ...fresh]
          : doc.devices,
        positions,
      }
    }
    case "removeDevices": {
      const gone = new Set(a.ids)
      const nodeIds = new Set(a.ids.map(devNode))
      const positions: DocPositions = {}
      for (const [style, map] of Object.entries(doc.positions) as [
        DocStyle,
        PosMap,
      ][]) {
        const kept = Object.entries(map).filter(([id]) => !nodeIds.has(id))
        if (kept.length) positions[style] = Object.fromEntries(kept)
      }
      const links = Object.fromEntries(
        Object.entries(doc.links).filter(
          ([key]) => !key.split("|").some((id) => gone.has(id))
        )
      )
      const nodes = Object.fromEntries(
        Object.entries(doc.nodes).filter(([id]) => !gone.has(id))
      )
      const hidden = {
        ...doc.hidden,
        devices: doc.hidden.devices.filter((id) => !nodeIds.has(id)),
      }
      const next: ViewDocument = {
        ...doc,
        devices: doc.devices?.filter((id) => !gone.has(id)) ?? null,
        positions,
        links,
        nodes,
        hidden,
      }
      return same(doc, next) ? doc : next
    }
    case "setRegions": {
      const next = a.regions.length ? a.regions : null
      const prev = doc.zones[a.style]
      if (same(prev?.length ? prev : null, next)) return doc
      return { ...doc, zones: withStyle(doc.zones, a.style, next) }
    }
    case "setLink": {
      if (same(doc.links[a.key] ?? null, a.value)) return doc
      const links = { ...doc.links }
      if (a.value) links[a.key] = a.value
      else delete links[a.key]
      return { ...doc, links }
    }
    case "setNode": {
      if (same(doc.nodes[a.id] ?? null, a.value)) return doc
      const nodes = { ...doc.nodes }
      if (a.value) nodes[a.id] = a.value
      else delete nodes[a.id]
      return { ...doc, nodes }
    }
    case "setNotes":
      return same(doc.notes, a.notes) ? doc : { ...doc, notes: a.notes }
    case "setHidden":
      return same(doc.hidden, a.hidden) ? doc : { ...doc, hidden: a.hidden }
    case "setDisplay": {
      const filters: TopologyViewFilters = { ...doc.filters }
      for (const [k, v] of Object.entries(a.patch)) {
        if (v === undefined) delete filters[k]
        else filters[k] = v
      }
      return same(doc.filters, filters) ? doc : { ...doc, filters }
    }
    case "replace":
      return a.doc === doc ? doc : a.doc
  }
}

/** The document plus its undo stack and the version it was loaded from. */
export interface DocHistory {
  past: ViewDocument[]
  present: ViewDocument
  future: ViewDocument[]
  /** The document as last opened or saved - `dirty` compares against it. */
  saved: ViewDocument
  /** Which map the document belongs to (`default`, `custom`, `view:<id>`). */
  key: string
  /** The saved view's `updated_at` the edits are based on. */
  base: string | null
  /** The coalescing key of the last step - see `HistoryMsg`. */
  step: string | null
}

export type HistoryMsg =
  /** One edit. Consecutive edits sharing a `step` key are one undo step
   * (a drag that moves a zone and snapshots the cards). */
  | { kind: "do"; action: DocAction; step?: string }
  | { kind: "undo" }
  | { kind: "redo" }
  /** A different map, or a fresh copy of this one: history is forgotten. */
  | { kind: "load"; doc: ViewDocument; key: string; base: string | null }
  /** `doc` is now what the server holds. The history stays, so a save can
   * still be undone - which makes the map dirty again. */
  | { kind: "saved"; doc: ViewDocument; key: string; base: string | null }

export function initHistory(
  doc: ViewDocument,
  key: string,
  base: string | null = null
): DocHistory {
  return {
    past: [],
    present: doc,
    future: [],
    saved: doc,
    key,
    base,
    step: null,
  }
}

export function historyReducer(h: DocHistory, m: HistoryMsg): DocHistory {
  switch (m.kind) {
    case "do": {
      const next = docReducer(h.present, m.action)
      if (next === h.present) return h
      if (m.step && m.step === h.step && h.past.length)
        return { ...h, present: next, future: [] }
      return {
        ...h,
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        step: m.step ?? null,
      }
    }
    case "undo": {
      const prev = h.past.at(-1)
      if (!prev) return h
      return {
        ...h,
        past: h.past.slice(0, -1),
        present: prev,
        future: [h.present, ...h.future],
        step: null,
      }
    }
    case "redo": {
      const next = h.future.at(0)
      if (!next) return h
      return {
        ...h,
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: h.future.slice(1),
        step: null,
      }
    }
    case "load":
      return initHistory(m.doc, m.key, m.base)
    case "saved":
      return { ...h, saved: m.doc, key: m.key, base: m.base, step: null }
  }
}

export interface ViewDocumentApi {
  doc: ViewDocument
  /** Changed since it was opened or last saved. */
  dirty: boolean
  /** `dirty` as of the latest call, for guards that run between renders. */
  dirtyRef: RefObject<boolean>
  /** The map the document belongs to. */
  docKey: string
  /** `updated_at` of the saved version the edits are based on. */
  base: string | null
  /** `coalesce` names a gesture: calls with the same name in one tick
   * (one event handler) become a single undo step. */
  dispatch: (action: DocAction, opts?: { coalesce?: string }) => void
  /** Step back; returns the document it steps to, or null at the start. */
  undo: () => ViewDocument | null
  redo: () => ViewDocument | null
  canUndo: boolean
  canRedo: boolean
  load: (doc: ViewDocument, key: string, base?: string | null) => void
  markSaved: (doc: ViewDocument, key: string, base?: string | null) => void
}

/** The page's handle on the document. `init` runs once, like useState's. */
export function useViewDocument(
  init: () => { doc: ViewDocument; key: string; base?: string | null }
): ViewDocumentApi {
  const [h, send] = useReducer(historyReducer, undefined, () => {
    const i = init()
    return initHistory(i.doc, i.key, i.base ?? null)
  })
  // The latest history for callbacks fired between renders (two keys in
  // one frame, a save that resolves before the re-render).
  const latest = useRef(h)
  latest.current = h
  const dirty = h.present !== h.saved
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  // One gesture = one step: calls sharing a name inside the same task get
  // the same key. The microtask closes the window after the handler.
  const tick = useRef({ n: 0, open: false })
  const dispatch = useCallback(
    (action: DocAction, opts?: { coalesce?: string }) => {
      let step: string | undefined
      if (opts?.coalesce) {
        const t = tick.current
        if (!t.open) {
          t.n += 1
          t.open = true
          queueMicrotask(() => {
            t.open = false
          })
        }
        step = `${opts.coalesce}#${t.n}`
      }
      send({ kind: "do", action, step })
    },
    []
  )
  const undo = useCallback(() => {
    const to = latest.current.past.at(-1) ?? null
    if (to) send({ kind: "undo" })
    return to
  }, [])
  const redo = useCallback(() => {
    const to = latest.current.future.at(0) ?? null
    if (to) send({ kind: "redo" })
    return to
  }, [])
  const load = useCallback(
    (doc: ViewDocument, key: string, base: string | null = null) => {
      dirtyRef.current = false
      send({ kind: "load", doc, key, base })
    },
    []
  )
  const markSaved = useCallback(
    (doc: ViewDocument, key: string, base: string | null = null) => {
      dirtyRef.current = latest.current.present !== doc
      send({ kind: "saved", doc, key, base })
    },
    []
  )
  return {
    doc: h.present,
    dirty,
    dirtyRef,
    docKey: h.key,
    base: h.base,
    dispatch,
    undo,
    redo,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    load,
    markSaved,
  }
}

/** Which map a location shows - the key the document and the leave guard
 * follow. A saved view is its own map even while it is built on by hand. */
export function mapKeyOf(search: Record<string, unknown>): string {
  const view = search.view
  if (typeof view === "string" && view) return `view:${view}`
  return search.devices !== undefined ? "custom" : "default"
}

/** Same page? Compared loosely so a trailing slash can't read as a move. */
const samePath = (a: string, b: string) =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "")

/**
 * The unsaved-edit guard. One dialog for every in-app way off a map with
 * unsaved edits: a sidebar link, browser back/forward, picking another view,
 * leaving a custom map. Same as the floor-plan editor, except that here the
 * map is in the query string - so a navigation that stays on the page but
 * lands on another map (another view, the default map) is a leave too,
 * while a filter or display change on the same map is not. The default map
 * is never guarded: it is kept in this browser as it changes.
 *
 * Returns the blocker the page's dialog answers. A move the page makes
 * itself once nothing can be lost - onto the view a save just wrote - goes
 * with `ignoreBlocker`: edits made while that save was in flight are still
 * unsaved, and would otherwise raise "Discard?" on the page's own redirect.
 */
export function useMapLeaveGuard(
  doc: Pick<ViewDocumentApi, "dirty" | "dirtyRef" | "docKey">
) {
  const { dirtyRef } = doc
  // shouldBlockFn reads refs so it stays referentially stable - an inline
  // closure would re-register the history blocker on every render.
  const guardedRef = useRef(false)
  guardedRef.current = doc.docKey !== "default"
  const shouldBlockFn = useCallback<ShouldBlockFn>(
    ({ current, next }) => {
      if (!dirtyRef.current || !guardedRef.current) return false
      if (!samePath(next.pathname, current.pathname)) return true
      return (
        mapKeyOf(next.search as Record<string, unknown>) !==
        mapKeyOf(current.search as Record<string, unknown>)
      )
    },
    [dirtyRef]
  )
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload: false,
    withResolver: true,
  })
  // Closing the tab or reloading never reaches the router - the browser's
  // own prompt is the only guard there. Registered only while it matters.
  const guardDirty = doc.dirty && doc.docKey !== "default"
  useEffect(() => {
    if (!guardDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [guardDirty, dirtyRef])
  return blocker
}

/** A save refused because the view changed since it was opened. */
export function isStaleViewError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  const tag = t?.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    !!t?.isContentEditable
  )
}

/**
 * Ctrl/Cmd+S saves, Ctrl/Cmd+Z undoes, Shift+Ctrl/Cmd+Z (or Ctrl+Y) redoes.
 * Undo and redo leave text fields to their own undo. A handler returning
 * false lets the browser have the key. Nothing fires inside an open dialog.
 */
export function useDocumentKeys(h: {
  enabled: boolean
  onSave: () => boolean
  onUndo: () => void
  onRedo: () => void
}) {
  const ref = useRef(h)
  ref.current = h
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = ref.current
      if (!cur.enabled || !(e.ctrlKey || e.metaKey) || e.altKey) return
      if (
        e.target instanceof Element &&
        e.target.closest("[role=dialog],[role=alertdialog]")
      )
        return
      const key = e.key.toLowerCase()
      if (key === "s" && !e.shiftKey) {
        if (e.repeat) {
          e.preventDefault()
          return
        }
        if (cur.onSave()) e.preventDefault()
        return
      }
      if (typing(e.target)) return
      if (key === "z") {
        e.preventDefault()
        if (e.shiftKey) cur.onRedo()
        else cur.onUndo()
      } else if (key === "y" && e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        cur.onRedo()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
}
