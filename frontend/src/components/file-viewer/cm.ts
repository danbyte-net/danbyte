import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state"
import type { Extension, Text } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutter,
  highlightSpecialChars,
  lineNumbers,
} from "@codemirror/view"
import type { DecorationSet } from "@codemirror/view"
import { codeFolding, foldGutter, foldService } from "@codemirror/language"

import type { Section } from "./sections"

// ─── Theme ────────────────────────────────────────────────────────────────
// Built on the app's semantic CSS variables, so one theme serves light and
// dark: the variables switch, the editor follows.
const MATCH = "color-mix(in oklch, oklch(0.83 0.16 85) 45%, transparent)"
const MATCH_CURRENT =
  "color-mix(in oklch, oklch(0.75 0.17 65) 70%, transparent)"

export const viewerTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "12.5px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "6px 0", caretColor: "transparent" },
  ".cm-line": { padding: "0 12px 0 6px" },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
    userSelect: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 10px" },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 2px",
    cursor: "pointer",
    color: "var(--muted-foreground)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    border: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    borderRadius: "4px",
    padding: "0 4px",
    margin: "0 4px",
  },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 28%, transparent)",
  },
  ".cm-fv-match": { backgroundColor: MATCH, borderRadius: "2px" },
  ".cm-fv-match-current": {
    backgroundColor: MATCH_CURRENT,
    outline:
      "1px solid color-mix(in oklch, oklch(0.6 0.17 60) 70%, transparent)",
  },
  ".cm-fv-head": { fontWeight: "600" },
  ".cm-fv-comment": { color: "var(--muted-foreground)" },
  ".cm-fv-add": {
    backgroundColor:
      "color-mix(in oklch, oklch(0.7 0.15 160) 14%, transparent)",
  },
  ".cm-fv-del": {
    backgroundColor: "color-mix(in oklch, oklch(0.64 0.2 25) 13%, transparent)",
  },
  ".cm-fv-gap": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  // A gap's label is not code: no syntax colours in it.
  ".cm-fv-gap span": { color: "inherit", fontWeight: "inherit" },
  ".cm-fv-empty": {
    backgroundColor: "color-mix(in oklch, var(--muted) 70%, transparent)",
  },
  ".cm-fv-num .cm-gutterElement": {
    padding: "0 6px 0 8px",
    textAlign: "right",
    minWidth: "2.5em",
  },
  ".cm-fv-mark .cm-gutterElement": { padding: "0 2px 0 4px" },
  ".cm-fv-mark .cm-fv-mark-add": { color: "oklch(0.55 0.14 160)" },
  ".cm-fv-mark .cm-fv-mark-del": { color: "oklch(0.58 0.2 25)" },
})

/** The base of every viewer: read-only, a visible selection, no caret. */
export function readOnlyBase(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    drawSelection(),
    highlightSpecialChars(),
    viewerTheme,
  ]
}

export { lineNumbers }

// ─── Search ───────────────────────────────────────────────────────────────
export interface Match {
  from: number
  to: number
}

interface SearchValue {
  query: string
  matches: Match[]
  current: number
  deco: DecorationSet
}

/** Set the search text and which match is current (-1 = none). */
export const setSearch = StateEffect.define<{
  query: string
  current: number
}>()

/** Enough to say "many" without walking a huge file for every keystroke. */
export const MAX_MATCHES = 5000

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Case-insensitive plain-text matches of `query` in `text`. */
export function findMatches(text: string, query: string): Match[] {
  if (!query) return []
  const re = new RegExp(escapeRe(query), "gi")
  const out: Match[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && out.length < MAX_MATCHES) {
    out.push({ from: m.index, to: m.index + m[0].length })
  }
  return out
}

const matchMark = Decoration.mark({ class: "cm-fv-match" })
const currentMark = Decoration.mark({
  class: "cm-fv-match cm-fv-match-current",
})

function buildSearch(doc: Text, query: string, current: number): SearchValue {
  const matches = findMatches(doc.toString(), query)
  const b = new RangeSetBuilder<Decoration>()
  matches.forEach((m, i) =>
    b.add(m.from, m.to, i === current ? currentMark : matchMark)
  )
  return { query, matches, current, deco: b.finish() }
}

export const searchField = StateField.define<SearchValue>({
  create: () => ({
    query: "",
    matches: [],
    current: -1,
    deco: Decoration.none,
  }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setSearch)) continue
      if (e.value.query === value.query) {
        // Same text, new current match: recolour without re-searching.
        const b = new RangeSetBuilder<Decoration>()
        value.matches.forEach((m, i) =>
          b.add(m.from, m.to, i === e.value.current ? currentMark : matchMark)
        )
        value = { ...value, current: e.value.current, deco: b.finish() }
      } else value = buildSearch(tr.state.doc, e.value.query, e.value.current)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})

/** The matches the view currently holds. */
export function matchesOf(view: EditorView): Match[] {
  return view.state.field(searchField, false)?.matches ?? []
}

// ─── Per-line classes ─────────────────────────────────────────────────────
/** Fixed line classes for a read-only document, one entry per line. */
export function lineClasses(
  doc: Text,
  classes: readonly (string | null | undefined)[]
): Extension {
  const b = new RangeSetBuilder<Decoration>()
  const cache = new Map<string, Decoration>()
  for (let i = 0; i < classes.length && i < doc.lines; i++) {
    const cls = classes[i]
    if (!cls) continue
    let deco = cache.get(cls)
    if (!deco) {
      deco = Decoration.line({ class: cls })
      cache.set(cls, deco)
    }
    const line = doc.line(i + 1)
    b.add(line.from, line.from, deco)
  }
  return EditorView.decorations.of(b.finish())
}

/** Mutes comment lines (`!`, `#`, `;`) and bolds section headers. */
export function configLineClasses(
  lines: readonly string[],
  sections: readonly Section[]
): (string | null)[] {
  const heads = new Set(sections.map((s) => s.line))
  return lines.map((l, i) => {
    if (heads.has(i + 1)) return "cm-fv-head"
    const t = l.trimStart()
    return t.startsWith("!") || t.startsWith("#") || t.startsWith(";")
      ? "cm-fv-comment"
      : null
  })
}

// ─── Folding ──────────────────────────────────────────────────────────────
/** Fold markers on every section header with a body. */
export function sectionFolding(sections: readonly Section[]): Extension[] {
  const byLine = new Map<number, Section>()
  for (const s of sections) if (s.end > s.line) byLine.set(s.line, s)
  return [
    foldService.of((state, from) => {
      const line = state.doc.lineAt(from)
      const s = byLine.get(line.number)
      if (!s || s.end > state.doc.lines) return null
      return { from: line.to, to: state.doc.line(s.end).to }
    }),
    codeFolding(),
    foldGutter({
      markerDOM(open) {
        const el = document.createElement("span")
        el.textContent = open ? "▾" : "▸"
        el.setAttribute("aria-hidden", "true")
        return el
      },
    }),
  ]
}

// ─── Diff gutters ─────────────────────────────────────────────────────────
class TextMarker extends GutterMarker {
  readonly text: string
  readonly cls: string
  constructor(text: string, cls = "") {
    super()
    this.text = text
    this.cls = cls
  }
  eq(other: GutterMarker): boolean {
    return (
      other instanceof TextMarker &&
      other.text === this.text &&
      other.cls === this.cls
    )
  }
  toDOM() {
    const el = document.createElement("span")
    el.textContent = this.text
    if (this.cls) el.className = this.cls
    return el
  }
}

/** A gutter of line numbers taken from `numbers` (one per document line,
 * null = blank) instead of the document's own. */
export function numberGutter(numbers: readonly (number | null)[]): Extension {
  const widest = numbers.reduce<number>((m, n) => Math.max(m, n ?? 0), 0)
  return gutter({
    class: "cm-fv-num",
    lineMarker(view, line) {
      const n = numbers[view.state.doc.lineAt(line.from).number - 1]
      return n == null ? null : new TextMarker(String(n))
    },
    initialSpacer: () => new TextMarker(String(widest || 1)),
  })
}

/** The `+`/`-` column of a diff, outside the text so it is not copied. */
export function markGutter(marks: readonly ("+" | "-" | null)[]): Extension {
  return gutter({
    class: "cm-fv-mark",
    lineMarker(view, line) {
      const m = marks[view.state.doc.lineAt(line.from).number - 1]
      if (!m) return null
      return new TextMarker(m, m === "+" ? "cm-fv-mark-add" : "cm-fv-mark-del")
    },
    initialSpacer: () => new TextMarker("+"),
  })
}

export const wrapping = EditorView.lineWrapping

/** Scroll `pos` into view inside the editor only. CodeMirror's own
 * scrollIntoView also scrolls the page, which jerks a viewer that already
 * fills the window. A second pass on the next frame corrects for line
 * heights measured once the new lines are drawn. */
export function scrollWithin(
  view: EditorView,
  pos: number,
  align: "center" | "start" = "center"
) {
  const place = () => {
    const s = view.scrollDOM
    const block = view.lineBlockAt(pos)
    const offset =
      view.documentTop - s.getBoundingClientRect().top + s.scrollTop
    const top = offset + block.top
    s.scrollTop =
      align === "center" ? top - (s.clientHeight - block.height) / 2 : top - 24
    const at = view.coordsAtPos(pos)
    if (at) {
      const box = s.getBoundingClientRect()
      const gutters = view.dom.querySelector(".cm-gutters")
      const left = box.left + (gutters?.getBoundingClientRect().width ?? 0)
      if (at.left < left || at.right > box.right)
        s.scrollLeft += at.left - left - 40
    }
  }
  place()
  requestAnimationFrame(place)
}
