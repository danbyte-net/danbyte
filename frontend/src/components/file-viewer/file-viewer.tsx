import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Text } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  GripHorizontal,
  Maximize2,
  Minimize2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { IconTip } from "@/components/icon-tip"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { copyWithToast } from "@/lib/clipboard"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"

import {
  configLineClasses,
  lineClasses,
  lineNumbers,
  markGutter,
  matchesOf,
  numberGutter,
  scrollWithin,
  sectionFolding,
  setSearch,
} from "./cm"
import { CodeView } from "./code-view"
import {
  collapseContext,
  diffRows,
  gapLabel,
  linesOf,
  sideBySide,
} from "./diff"
import type { DiffRow } from "./diff"
import { pickHighlight, syntaxFor } from "./highlight"
import type { Highlight } from "./highlight"
import { jsonSectionsOf, sectionsOf } from "./sections"
import type { Section } from "./sections"
import { clearHeight, readHeight, writeHeight } from "./storage"

/** `config` (the default) and `auto` pick the colouring from the file name
 * or the text; `config` falls back to network config, `auto` to plain. */
export type FileLanguage = "config" | "auto" | Highlight
type View = "file" | "diff"
type Layout = "unified" | "split"

const MIN_HEIGHT = 200
const FILL_HEIGHT = "max(600px, calc(100dvh - 10rem))"
const FIT_MAX = "32rem"

export interface FileViewerProps {
  text: string
  /** The file's path; shown in the header and names the download. */
  path?: string
  /** Download name; defaults to the last part of `path`. */
  filename?: string
  /** Header extras after the path: a hash, a push badge. */
  meta?: ReactNode
  /** Unified diff against another version; adds a Diff view. */
  diff?: string | null
  diffLabel?: string
  /** The tab for the text itself when there is a diff. */
  fileLabel?: string
  /** Open on the diff rather than the text. */
  defaultView?: "file" | "diff"
  /** Above the outline in the side column, e.g. a bundle's file list. */
  aside?: ReactNode
  /** What the text is: drives the colouring, outline and folding. */
  language?: FileLanguage
  /** `fill` takes the window's height; `fit` grows with the text up to a
   * cap. Either is resizable from its bottom edge. */
  height?: "fill" | "fit"
  /** Where the dragged height is remembered (per user). */
  storageKey?: string
  /** `/` focuses this viewer's search. */
  hotkey?: boolean
  /** Keep scrolled to the bottom as the text grows (a live log). */
  follow?: boolean
  defaultWrap?: boolean
  /** Shown instead of an empty document. */
  emptyText?: string
  label?: string
  className?: string
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  )
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <IconTip label={label}>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </Button>
    </IconTip>
  )
}

function CheckLabel({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}) {
  return (
    <label className="flex items-center gap-1.5 text-[13px] whitespace-nowrap">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      {children}
    </label>
  )
}

/** Languages with `[Section]`, `interface …` and `### FILE:` structure. */
function isConfig(lang: Highlight): boolean {
  return lang === "netconf" || lang === "ini"
}

function sectionsFor(text: string, lang: Highlight): Section[] {
  if (isConfig(lang)) return sectionsOf(text)
  if (lang === "json") return jsonSectionsOf(text)
  return []
}

/** A read-only file: line numbers, search, wrap, copy and download, an
 * outline of its sections with fold markers, an optional diff view
 * (unified or side by side), resizable, and full screen. */
export function FileViewer({
  text,
  path,
  filename,
  meta,
  diff,
  diffLabel = "Diff vs last push",
  fileLabel = "Rendered",
  defaultView = "file",
  aside,
  language = "config",
  height = "fit",
  storageKey,
  hotkey = false,
  follow = false,
  defaultWrap = false,
  emptyText = "(empty)",
  label,
  className,
}: FileViewerProps) {
  const { me } = useMe()
  const user = me.username ?? ""
  const rootRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const hasDiff = !!diff && diff.trim().length > 0
  const [viewState, setView] = useState<View>(defaultView)
  const view: View = hasDiff ? viewState : "file"
  const [layout, setLayout] = useState<Layout>("unified")
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [wrap, setWrap] = useState(defaultWrap)
  const [full, setFull] = useState(false)
  const [query, setQuery] = useState("")
  const [current, setCurrent] = useState(-1)
  const [count, setCount] = useState(0)
  const [jump, setJump] = useState<number | null>(null)
  const [primary, setPrimary] = useState<EditorView | null>(null)
  const [secondary, setSecondary] = useState<EditorView | null>(null)
  const [dragged, setDragged] = useState<number | null>(() =>
    storageKey ? readHeight(user, storageKey) : null
  )
  // `me` may land after the first render; pick the stored height up then.
  useEffect(() => {
    if (storageKey) setDragged(readHeight(user, storageKey))
  }, [user, storageKey])

  const hl = useMemo(
    () =>
      pickHighlight({
        language: language === "config" ? "auto" : language,
        name: filename ?? path,
        text,
        fallback: language === "config" ? "netconf" : "text",
      }),
    [language, filename, path, text]
  )
  const syntax = useMemo(() => syntaxFor(hl), [hl])
  const sections = useMemo(() => sectionsFor(text, hl), [text, hl])
  const outline = useMemo(
    () =>
      isConfig(hl)
        ? sections.filter((s) => s.title !== "" && s.level <= 2)
        : [],
    [sections, hl]
  )
  const topLevel = outline.reduce((m, s) => Math.min(m, s.level), 9)
  const lineCount = useMemo(() => linesOf(text).length, [text])

  // ── Documents and their extensions ──────────────────────────────────────
  const fileExt = useMemo(() => {
    const lines = text.split("\n")
    const doc = Text.of(lines)
    const ext = [lineNumbers(), syntax]
    if (sections.some((s) => s.end > s.line))
      ext.push(...sectionFolding(sections))
    if (isConfig(hl))
      ext.push(lineClasses(doc, configLineClasses(lines, sections)))
    return ext
  }, [text, sections, hl, syntax])

  const rows = useMemo<DiffRow[]>(() => {
    if (!hasDiff || !diff || view !== "diff") return []
    const all = diffRows(diff, text)
    return onlyChanges ? collapseContext(all, 3) : all
  }, [hasDiff, view, diff, text, onlyChanges])

  const unified = useMemo(() => {
    if (view !== "diff" || layout !== "unified") return null
    const lines = rows.map((r) =>
      r.kind === "gap" ? gapLabel(r.hidden) : r.text
    )
    const doc = Text.of(lines.length ? lines : [""])
    return {
      doc: lines.join("\n"),
      ext: [
        syntax,
        numberGutter(rows.map((r) => (r.kind === "gap" ? null : r.old))),
        numberGutter(rows.map((r) => (r.kind === "gap" ? null : r.new))),
        markGutter(
          rows.map((r) =>
            r.kind === "add" ? "+" : r.kind === "del" ? "-" : null
          )
        ),
        lineClasses(
          doc,
          rows.map((r) =>
            r.kind === "add"
              ? "cm-fv-add"
              : r.kind === "del"
                ? "cm-fv-del"
                : r.kind === "gap"
                  ? "cm-fv-gap"
                  : null
          )
        ),
      ],
    }
  }, [view, layout, rows, syntax])

  const split = useMemo(() => {
    if (view !== "diff" || layout !== "split") return null
    const pairs = sideBySide(rows)
    const side = (which: "left" | "right") => {
      const lines = pairs.map((p) =>
        p.kind === "gap" ? gapLabel(p.hidden) : (p[which]?.text ?? "")
      )
      const doc = Text.of(lines.length ? lines : [""])
      const changed = which === "left" ? "del" : "add"
      return {
        doc: lines.join("\n"),
        ext: [
          syntax,
          numberGutter(
            pairs.map((p) =>
              p.kind === "gap"
                ? null
                : which === "left"
                  ? (p.left?.old ?? null)
                  : (p.right?.new ?? null)
            )
          ),
          markGutter(
            pairs.map((p) =>
              p.kind === "pair" && p[which]?.kind === changed
                ? which === "left"
                  ? "-"
                  : "+"
                : null
            )
          ),
          lineClasses(
            doc,
            pairs.map((p) =>
              p.kind === "gap"
                ? "cm-fv-gap"
                : p[which] === null
                  ? "cm-fv-empty"
                  : p[which].kind === changed
                    ? `cm-fv-${changed}`
                    : null
            )
          ),
        ],
      }
    }
    return { left: side("left"), right: side("right") }
  }, [view, layout, rows, syntax])

  const docKey =
    view === "file" ? text : (unified?.doc ?? split?.right.doc ?? "")

  // ── Search ──────────────────────────────────────────────────────────────
  const goTo = useCallback(
    (i: number) => {
      if (!primary) return
      const matches = matchesOf(primary)
      if (matches.length === 0) return
      const idx = ((i % matches.length) + matches.length) % matches.length
      const m = matches[idx]
      primary.dispatch({ effects: setSearch.of({ query, current: idx }) })
      scrollWithin(primary, m.from)
      setCurrent(idx)
    },
    [primary, query]
  )

  useEffect(() => {
    for (const v of [primary, secondary])
      v?.dispatch({ effects: setSearch.of({ query, current: -1 }) })
    const n = primary ? matchesOf(primary).length : 0
    setCount(n)
    setCurrent(-1)
    if (n > 0 && primary) {
      const m = matchesOf(primary)[0]
      primary.dispatch({ effects: setSearch.of({ query, current: 0 }) })
      scrollWithin(primary, m.from)
      setCurrent(0)
    }
  }, [query, primary, secondary, docKey])

  // ── Outline jumps ───────────────────────────────────────────────────────
  useEffect(() => {
    if (jump === null || view !== "file" || !primary) return
    const doc = primary.state.doc
    if (jump <= doc.lines) {
      const line = doc.line(jump)
      primary.dispatch({ selection: { anchor: line.from, head: line.to } })
      scrollWithin(primary, line.from, "start")
    }
    setJump(null)
  }, [jump, view, primary])

  // ── Side-by-side scroll sync ────────────────────────────────────────────
  useEffect(() => {
    if (!primary || !secondary) return
    const a = secondary.scrollDOM
    const b = primary.scrollDOM
    let busy = false
    const sync = (from: HTMLElement, to: HTMLElement) => () => {
      if (busy) return
      busy = true
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
      requestAnimationFrame(() => (busy = false))
    }
    const ab = sync(a, b)
    const ba = sync(b, a)
    a.addEventListener("scroll", ab)
    b.addEventListener("scroll", ba)
    return () => {
      a.removeEventListener("scroll", ab)
      b.removeEventListener("scroll", ba)
    }
  }, [primary, secondary])

  // ── Keyboard: `/` to search, Esc out of full screen ─────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && full) {
        setFull(false)
        return
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return
      if (!hotkey && !full) return
      if (isTypingTarget(e.target)) return
      const root = rootRef.current
      if (!root || (!full && root.offsetParent === null)) return
      // Ahead of the global search palette's own `/`.
      e.preventDefault()
      e.stopPropagation()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [hotkey, full])

  useEffect(() => {
    if (!full) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [full])

  // ── Resize ──────────────────────────────────────────────────────────────
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const section = sectionRef.current
    if (!section || full) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = section.getBoundingClientRect().height
    let h = startH
    const move = (ev: PointerEvent) => {
      h = Math.max(MIN_HEIGHT, Math.round(startH + ev.clientY - startY))
      setDragged(h)
    }
    const up = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", up)
      handle.removeEventListener("pointercancel", up)
      if (storageKey) writeHeight(user, storageKey, h)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", up)
    handle.addEventListener("pointercancel", up)
  }
  const nudge = (delta: number) => {
    const section = sectionRef.current
    if (!section) return
    const h = Math.max(
      MIN_HEIGHT,
      Math.round(section.getBoundingClientRect().height + delta)
    )
    setDragged(h)
    if (storageKey) writeHeight(user, storageKey, h)
  }
  const resetHeight = () => {
    setDragged(null)
    if (storageKey) clearHeight(user, storageKey)
  }

  // A fixed height: dragged, full screen, or the window-filling default.
  const fixed = full || dragged !== null || height === "fill"
  const sectionStyle: React.CSSProperties | undefined = full
    ? undefined
    : dragged !== null
      ? { height: dragged }
      : height === "fill"
        ? { height: FILL_HEIGHT }
        : undefined

  const content = view === "diff" ? diff! : text
  const name =
    (filename ?? (path ? basename(path) : "file.txt")) +
    (view === "diff" ? ".diff" : "")
  const viewerLabel = label ?? (path ? `${path} content` : "File content")
  const empty = view === "file" && text === ""
  const showOutline = view === "file" && outline.length > 0
  const hasSide = !!aside || showOutline

  const bodyCls = cn(
    "relative min-w-0 bg-muted/30",
    fixed
      ? "flex min-h-0 flex-1 flex-col [&_.cm-editor]:min-h-0 [&_.cm-editor]:flex-1"
      : "[&_.cm-editor]:max-h-[inherit]"
  )
  const bodyStyle = fixed ? undefined : { maxHeight: FIT_MAX }

  return (
    <div
      ref={rootRef}
      className={cn(
        full
          ? "fixed inset-0 z-50 flex flex-col bg-background p-4"
          : "flex flex-col",
        className
      )}
    >
      <div
        className={cn(
          "flex min-h-0 flex-col gap-4 lg:flex-row",
          full && "flex-1"
        )}
      >
        {hasSide && (
          <aside
            aria-label="Files and outline"
            className="relative shrink-0 lg:w-72"
          >
            <div className="flex max-h-72 flex-col gap-4 overflow-auto lg:absolute lg:inset-0 lg:max-h-none">
              {aside}
              {showOutline && (
                <section className="rounded-lg border border-border p-2">
                  <h3 className="mx-2 mt-1 mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    Outline
                  </h3>
                  <ul className="flex flex-col">
                    {outline.map((s) => (
                      <li key={s.line}>
                        <button
                          type="button"
                          onClick={() => setJump(s.line)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left font-mono text-[12px] hover:bg-muted",
                            s.level - topLevel >= 2
                              ? "pl-8"
                              : s.level - topLevel === 1
                                ? "pl-5"
                                : "pl-2"
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {s.title}
                          </span>
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {s.line}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </aside>
        )}

        <section
          ref={sectionRef}
          aria-label="File viewer"
          style={sectionStyle}
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card",
            full && "min-h-0"
          )}
        >
          {(path || meta || hasDiff) && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              {path && (
                <span className="min-w-0 truncate font-mono text-[13px] font-medium">
                  {path}
                </span>
              )}
              {meta}
              {hasDiff && (
                <SegmentedTabs<View>
                  className="ml-auto"
                  items={[
                    { value: "file", label: fileLabel },
                    { value: "diff", label: diffLabel },
                  ]}
                  value={view}
                  onValueChange={setView}
                />
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <div className="relative">
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    goTo(e.shiftKey ? current - 1 : current + 1)
                  } else if (e.key === "Escape") {
                    e.stopPropagation()
                    setQuery("")
                    e.currentTarget.blur()
                  }
                }}
                placeholder="Search in file"
                aria-label="Search in file"
                className="h-8 w-56 pr-8 text-[13px]"
              />
              {(hotkey || full) && !query && (
                <Kbd className="absolute top-1.5 right-1.5">/</Kbd>
              )}
            </div>
            {query && (
              <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {count === 0
                  ? "No matches"
                  : `${current + 1} of ${count}${count >= 5000 ? "+" : ""} match${count === 1 ? "" : "es"}`}
              </span>
            )}
            <IconButton
              label="Previous match"
              onClick={() => goTo(current - 1)}
              disabled={count === 0}
            >
              <ChevronUp className="size-4" />
            </IconButton>
            <IconButton
              label="Next match"
              onClick={() => goTo(current + 1)}
              disabled={count === 0}
            >
              <ChevronDown className="size-4" />
            </IconButton>
            {view === "diff" && (
              <>
                <SegmentedTabs<Layout>
                  items={[
                    { value: "unified", label: "Unified" },
                    { value: "split", label: "Side by side" },
                  ]}
                  value={layout}
                  onValueChange={setLayout}
                />
                <CheckLabel checked={onlyChanges} onChange={setOnlyChanges}>
                  Only changes
                </CheckLabel>
              </>
            )}
            {!(view === "diff" && layout === "split") && (
              <CheckLabel checked={wrap} onChange={setWrap}>
                Wrap
              </CheckLabel>
            )}
            <span className="ml-auto flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => copyWithToast(content, "Copied")}
              >
                <Copy className="size-3.5" />
                Copy
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => download(content, name)}
              >
                <Download className="size-3.5" />
                Download
              </Button>
              <IconButton
                label={full ? "Exit full screen" : "Full screen"}
                onClick={() => setFull((f) => !f)}
              >
                {full ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </IconButton>
            </span>
          </div>

          {empty ? (
            <div
              className={cn(
                "px-4 py-6 text-sm text-muted-foreground",
                fixed && "flex-1"
              )}
            >
              {emptyText}
            </div>
          ) : view === "file" ? (
            <CodeView
              key="file"
              doc={text}
              extensions={fileExt}
              wrap={wrap}
              follow={follow}
              label={viewerLabel}
              onView={setPrimary}
              className={bodyCls}
              style={bodyStyle}
            />
          ) : unified ? (
            <CodeView
              key="unified"
              doc={unified.doc}
              extensions={unified.ext}
              wrap={wrap}
              label={`${viewerLabel}, diff`}
              onView={setPrimary}
              className={bodyCls}
              style={bodyStyle}
            />
          ) : split ? (
            <div
              className={cn(
                "grid min-w-0 grid-cols-2 divide-x divide-border",
                fixed && "min-h-0 flex-1 grid-rows-1"
              )}
            >
              <CodeView
                key="left"
                doc={split.left.doc}
                extensions={split.left.ext}
                wrap={false}
                label={`${viewerLabel}, last push`}
                onView={setSecondary}
                className={bodyCls}
                style={bodyStyle}
              />
              <CodeView
                key="right"
                doc={split.right.doc}
                extensions={split.right.ext}
                wrap={false}
                label={`${viewerLabel}, rendered`}
                onView={setPrimary}
                className={bodyCls}
                style={bodyStyle}
              />
            </div>
          ) : null}

          <div className="flex items-center gap-4 border-t border-border px-3 py-1 text-xs text-muted-foreground">
            <span className="whitespace-nowrap tabular-nums">
              {lineCount} line{lineCount === 1 ? "" : "s"}
            </span>
            {view === "diff" && (
              <span className="whitespace-nowrap tabular-nums">
                +{rows.filter((r) => r.kind === "add").length} −
                {rows.filter((r) => r.kind === "del").length}
              </span>
            )}
          </div>
          {!full && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize viewer"
              tabIndex={0}
              onPointerDown={startDrag}
              onDoubleClick={resetHeight}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault()
                  nudge(-40)
                } else if (e.key === "ArrowDown") {
                  e.preventDefault()
                  nudge(40)
                }
              }}
              className="flex h-3 cursor-row-resize touch-none items-center justify-center border-t border-border bg-muted/40 text-muted-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              <GripHorizontal className="size-3.5" />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
