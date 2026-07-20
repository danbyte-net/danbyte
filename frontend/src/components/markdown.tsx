import { Fragment, type ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A deliberately small, safe Markdown renderer for operator-authored text
 * (compliance remediation guides, notes). Parses a practical subset —
 * headings, paragraphs, ordered/unordered lists, fenced code blocks, inline
 * `code`, **bold**, *italic*, and [links](https://…) — straight to React
 * elements. No HTML pass-through and no dangerouslySetInnerHTML, so raw
 * HTML/script in the source renders as plain text and needs no sanitizer.
 */

// ─── inline spans ────────────────────────────────────────────────────────────

// Ordered by precedence: code first (its content is taken verbatim), then
// links, bold, italic.
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/

function renderInline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let k = key
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const tok = m[0]
    if (tok.startsWith("`")) {
      out.push(
        <code
          key={k++}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith("[")) {
      const close = tok.indexOf("](")
      const label = tok.slice(1, close)
      const href = tok.slice(close + 2, -1)
      // Only genuine web links become anchors; anything else (javascript:,
      // data:, relative paths) stays inert text.
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a
            key={k++}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {renderInline(label, k * 100)}
          </a>
        )
      } else {
        out.push(<Fragment key={k++}>{renderInline(label, k * 100)}</Fragment>)
      }
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={k++} className="font-semibold text-foreground">
          {renderInline(tok.slice(2, -2), k * 100)}
        </strong>
      )
    } else {
      out.push(<em key={k++}>{renderInline(tok.slice(1, -1), k * 100)}</em>)
    }
    rest = rest.slice(m.index + tok.length)
  }
  return out
}

// ─── block structure ─────────────────────────────────────────────────────────

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "p"; text: string }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
      continue
    }
    // fenced code block
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence (or EOF)
      blocks.push({ kind: "code", text: buf.join("\n") })
      continue
    }
    // heading
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] })
      i++
      continue
    }
    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ""))
      blocks.push({ kind: "ul", items })
      continue
    }
    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))
      blocks.push({ kind: "ol", items })
      continue
    }
    // paragraph — consecutive plain lines
    const buf: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4})\s|^```|^\s*[-*]\s+|^\s*\d+[.)]\s+/.test(lines[i])
    )
      buf.push(lines[i++])
    blocks.push({ kind: "p", text: buf.join(" ") })
  }
  return blocks
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold text-foreground",
  2: "text-sm font-semibold text-foreground",
  3: "text-[13px] font-semibold text-foreground",
  4: "text-[13px] font-medium text-foreground",
}

export function Markdown({
  source,
  className,
}: {
  source: string
  className?: string
}) {
  const blocks = parseBlocks(source)
  return (
    <div
      className={cn(
        "space-y-2 text-[13px] leading-relaxed text-muted-foreground",
        className
      )}
    >
      {blocks.map((b, idx) => {
        switch (b.kind) {
          case "heading": {
            const Tag = `h${Math.min(b.level + 2, 6)}` as "h3"
            return (
              <Tag key={idx} className={HEADING_CLASS[b.level]}>
                {renderInline(b.text)}
              </Tag>
            )
          }
          case "code":
            return (
              <pre
                key={idx}
                className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-xs text-foreground"
              >
                {b.text}
              </pre>
            )
          case "ul":
            return (
              <ul key={idx} className="list-disc space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            )
          case "ol":
            return (
              <ol key={idx} className="list-decimal space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            )
          default:
            return <p key={idx}>{renderInline(b.text)}</p>
        }
      })}
    </div>
  )
}
