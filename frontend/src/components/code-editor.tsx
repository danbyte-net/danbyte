import { useMemo } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { python } from "@codemirror/lang-python"
import { EditorView } from "@codemirror/view"
import { oneDark } from "@codemirror/theme-one-dark"

import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"

export type CodeLanguage = "python" | "plain"

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
}: {
  value: string
  onChange?: (v: string) => void
  language?: CodeLanguage
  height?: string
  readOnly?: boolean
  placeholder?: string
  className?: string
}) {
  const { theme } = useTheme()
  const extensions = useMemo(() => {
    const base = [EditorView.lineWrapping]
    return language === "python" ? [python(), ...base] : base
  }, [language])

  return (
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
}
