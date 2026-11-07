import { useEffect, useRef } from "react"
import { Compartment, EditorState } from "@codemirror/state"
import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { readOnlyBase, searchField, wrapping } from "./cm"

/** One read-only CodeMirror view. The view lives as long as the component;
 * a new `doc` replaces the text in place (an append only adds the tail, so
 * a growing log keeps its scroll), and `extensions` swap in alongside it. */
export function CodeView({
  doc,
  extensions,
  wrap,
  label,
  follow = false,
  onView,
  className,
  style,
}: {
  doc: string
  /** Built for this `doc`; keep the array stable while the doc is. */
  extensions: Extension[]
  wrap: boolean
  label: string
  /** Keep scrolled to the bottom as the text grows. */
  follow?: boolean
  onView?: (view: EditorView | null) => void
  className?: string
  style?: React.CSSProperties
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const parts = useRef({ doc: new Compartment(), wrap: new Compartment() })
  // The first render's props seed the view; later ones go through effects.
  const initial = useRef({ doc, extensions, wrap, label, follow })
  const onViewRef = useRef(onView)
  useEffect(() => {
    onViewRef.current = onView
  })

  useEffect(() => {
    const {
      doc: d,
      extensions: ext,
      wrap: w,
      label: l,
      follow: f,
    } = initial.current
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: d,
        extensions: [
          readOnlyBase(),
          searchField,
          parts.current.doc.of(ext),
          parts.current.wrap.of(w ? wrapping : []),
        ],
      }),
    })
    // Read-only content is not focusable; the scroller is, so the keyboard
    // can scroll it and screen readers can name it.
    view.scrollDOM.tabIndex = 0
    view.scrollDOM.setAttribute("aria-label", l)
    if (f)
      view.dispatch({
        effects: EditorView.scrollIntoView(d.length, { y: "end" }),
      })
    viewRef.current = view
    onViewRef.current?.(view)
    return () => {
      onViewRef.current?.(null)
      viewRef.current = null
      view.destroy()
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const old = view.state.doc.toString()
    const effects = parts.current.doc.reconfigure(extensions)
    if (old === doc) {
      view.dispatch({ effects })
      return
    }
    const changes = doc.startsWith(old)
      ? { from: old.length, insert: doc.slice(old.length) }
      : { from: 0, to: old.length, insert: doc }
    view.dispatch({ changes, effects })
    if (follow)
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }),
      })
  }, [doc, extensions, follow])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: parts.current.wrap.reconfigure(wrap ? wrapping : []),
    })
  }, [wrap])

  useEffect(() => {
    viewRef.current?.scrollDOM.setAttribute("aria-label", label)
  }, [label])

  return <div ref={host} className={className} style={style} />
}
