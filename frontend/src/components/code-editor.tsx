import { useMemo, useState } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { python } from "@codemirror/lang-python"
import { linter, lintGutter } from "@codemirror/lint"
import type { Diagnostic } from "@codemirror/lint"
import { EditorView } from "@codemirror/view"
import { oneDark } from "@codemirror/theme-one-dark"

import { api } from "@/lib/api"
import type { TemplateCheck } from "@/lib/api"

import { useTheme } from "@/components/theme-provider"
import { useFieldControl } from "@/components/ui/field-control"
import { cn } from "@/lib/utils"

export type CodeLanguage = "python" | "plain"

/** Check the text while typing (#465): `POST url` with `{[field]: text}`,
 * answered `{ok, error: {message, line}}` - the save-time Jinja check. */
export interface CodeCheck {
  url: string
  field: string
}

/** Pause after the last keystroke before the check runs. */
const CHECK_DELAY = 600

function checkSource(check: CodeCheck, report: (e: CheckError) => void) {
  return async (view: EditorView): Promise<Diagnostic[]> => {
    const text = view.state.doc.toString()
    let r: TemplateCheck
    try {
      r = await api<TemplateCheck>(check.url, {
        method: "POST",
        body: JSON.stringify({ [check.field]: text }),
      })
    } catch {
      // A refused or failed check (rate limit, offline) marks nothing; save
      // still runs the same check.
      return []
    }
    // The text moved on while the check was out: its own check follows.
    if (view.state.doc.toString() !== text) return []
    if (r.ok || !r.error) {
      report(null)
      return []
    }
    const doc = view.state.doc
    const n = Math.min(Math.max(r.error.line ?? 1, 1), doc.lines)
    const line = doc.line(n)
    report({ line: n, message: r.error.message })
    return [
      {
        from: line.from,
        to: line.to,
        severity: "error",
        message: r.error.message,
        source: "Jinja",
      },
    ]
  }
}

type CheckError = { line: number; message: string } | null

/** The one code field in the product: scripts, and any template that used to
 * hand-roll a monospace textarea. Line numbers and Python highlighting, the
 * editor's own theme following the app's. */
export function CodeEditor({
  value,
  onChange,
  language = "plain",
  height = "24rem",
  readOnly = false,
  placeholder,
  className,
  check,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange?: (v: string) => void
  language?: CodeLanguage
  height?: string
  readOnly?: boolean
  placeholder?: string
  className?: string
  /** Underline template syntax errors while typing. */
  check?: CodeCheck
  /** Name for an editor with no Field label around it. */
  "aria-label"?: string
}) {
  const { theme } = useTheme()
  // The editable surface is CodeMirror's own `.cm-content` (a textbox), so
  // its name goes there, from the surrounding Field's label or `aria-label`
  // (#461).
  const field = useFieldControl()
  const [error, setError] = useState<CheckError>(null)
  const checkUrl = check?.url
  const checkField = check?.field
  const extensions = useMemo(() => {
    const named: Record<string, string> = ariaLabel
      ? { "aria-label": ariaLabel }
      : field
        ? { "aria-labelledby": field.labelId }
        : {}
    if (field?.describedBy) named["aria-describedby"] = field.describedBy
    const base = [
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(named),
    ]
    if (checkUrl && checkField)
      base.push(
        linter(checkSource({ url: checkUrl, field: checkField }, setError), {
          delay: CHECK_DELAY,
        }),
        lintGutter()
      )
    return language === "python" ? [python(), ...base] : base
  }, [language, ariaLabel, field, checkUrl, checkField])

  const editor = (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input text-[13px]",
        className
      )}
    >
      <CodeMirror
        value={value}
        height={height}
        theme={theme === "dark" ? oneDark : "light"}
        extensions={extensions}
        editable={!readOnly}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
          searchKeymap: true,
        }}
      />
    </div>
  )
  if (!check) return editor
  return (
    <div>
      {editor}
      {error && (
        <p className="mt-1 font-mono text-[12px] text-destructive">
          Line {error.line}: {error.message}
        </p>
      )}
    </div>
  )
}
