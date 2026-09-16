import { Fragment, type ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A deliberately small, safe Markdown renderer for operator-authored text
 * (compliance remediation guides, notes) and GitHub release notes. Parses
 * a practical GitHub-flavoured subset - headings, paragraphs, nested
 * ordered/unordered lists, task lists, blockquotes, rules, pipe tables,
 * fenced code blocks, inline `code`, **bold**, *italic*, ~~struck~~,
 * [links](https://…), bare URLs and `#123` issue references - straight to
 * React elements. No HTML pass-through and no dangerouslySetInnerHTML, so
 * raw HTML/script in the source renders as plain text and needs no
 * sanitizer.
 */

// ─── inline spans ────────────────────────────────────────────────────────────

// Ordered by precedence: code first (its content is taken verbatim), then
// links, bold, strike, italic, a bare URL, an issue reference.
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*\n]+\*)|(\bhttps?:\/\/[^\s<>()]+)|((?<![\w/])#\d+\b)/

function renderInline(text: string, key = 0, issueBase?: string): ReactNode[] {
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
            {renderInline(label, k * 100, issueBase)}
          </a>
        )
      } else {
        out.push(
          <Fragment key={k++}>
            {renderInline(label, k * 100, issueBase)}
          </Fragment>
        )
      }
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={k++} className="font-semibold text-foreground">
          {renderInline(tok.slice(2, -2), k * 100, issueBase)}
        </strong>
      )
    } else if (tok.startsWith("~~")) {
      out.push(
        <del key={k++}>
          {renderInline(tok.slice(2, -2), k * 100, issueBase)}
        </del>
      )
    } else if (tok.startsWith("*")) {
      out.push(
        <em key={k++}>{renderInline(tok.slice(1, -1), k * 100, issueBase)}</em>
      )
    } else if (tok.startsWith("#")) {
      // #123 - an issue in the repo the text came from, when we know it.
      out.push(
        issueBase ? (
          <a
            key={k++}
            href={`${issueBase}${tok.slice(1)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {tok}
          </a>
        ) : (
          tok
        )
      )
    } else {
      // A bare URL. Trailing punctuation belongs to the sentence.
      const trimmed = tok.replace(/[.,;:!?]+$/, "")
      out.push(
        <a
          key={k++}
          href={trimmed}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all underline underline-offset-2 hover:text-foreground"
        >
          {trimmed}
        </a>
      )
      if (trimmed.length < tok.length) out.push(tok.slice(trimmed.length))
    }
    rest = rest.slice(m.index + tok.length)
  }
  return out
}

// ─── block structure ─────────────────────────────────────────────────────────

interface ListItem {
  text: string
  /** A task-list box: checked, unchecked, or not a task. */
  task?: boolean
  children?: Block[]
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; align: string[]; rows: string[][] }
  | { kind: "p"; text: string }

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    BULLET.test(line) ||
    HR.test(line) ||
    /^\s*>/.test(line) ||
    TABLE_ROW.test(line)
  )
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"))
}

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
    if (FENCE.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence (or EOF)
      blocks.push({ kind: "code", text: buf.join("\n") })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (HR.test(line)) {
      blocks.push({ kind: "hr" })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]))
        buf.push(lines[i++].replace(/^\s*>\s?/, ""))
      blocks.push({ kind: "quote", blocks: parseBlocks(buf.join("\n")) })
      continue
    }
    if (
      TABLE_ROW.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1])
    ) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":")
          ? "center"
          : c.endsWith(":")
            ? "right"
            : "left"
      )
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i]))
        rows.push(splitRow(lines[i++]))
      blocks.push({ kind: "table", header, align, rows })
      continue
    }
    const b = BULLET.exec(line)
    if (b) {
      const ordered = /\d/.test(b[2])
      const base = b[1].length
      const items: ListItem[] = []
      while (i < lines.length) {
        const m = BULLET.exec(lines[i])
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break
        i++
        // Lines indented past the marker belong to this item: a nested
        // list, or the item's own continuation.
        const inner: string[] = []
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          (lines[i].length - lines[i].trimStart().length > base ||
            !isBlockStart(lines[i]))
        )
          inner.push(lines[i++])
        // Skip a single blank line inside a list only when a deeper item follows.
        while (
          i < lines.length &&
          lines[i].trim() === "" &&
          i + 1 < lines.length &&
          lines[i + 1].length - lines[i + 1].trimStart().length > base &&
          BULLET.test(lines[i + 1])
        ) {
          i++
          while (
            i < lines.length &&
            lines[i].trim() !== "" &&
            lines[i].length - lines[i].trimStart().length > base
          )
            inner.push(lines[i++])
        }
        let text = m[3]
        let task: boolean | undefined
        const t = /^\[([ xX])\]\s+(.*)$/.exec(text)
        if (t) {
          task = t[1] !== " "
          text = t[2]
        }
        const continuation = inner.filter((l) => !BULLET.test(l))
        const nested = inner.filter(
          (l) => BULLET.test(l) || l.length - l.trimStart().length > base + 1
        )
        if (continuation.length && !nested.length)
          text += " " + continuation.map((l) => l.trim()).join(" ")
        items.push({
          text,
          task,
          children: nested.length ? parseBlocks(dedent(inner)) : undefined,
        })
      }
      blocks.push({ kind: ordered ? "ol" : "ul", items })
      continue
    }
    // paragraph - consecutive plain lines; a trailing double space or a
    // backslash is a hard break.
    const buf: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isBlockStart(lines[i])
    )
      buf.push(lines[i++])
    blocks.push({ kind: "p", text: buf.join("\n") })
  }
  return blocks
}

function dedent(lines: string[]): string {
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => l.length - l.trimStart().length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min)).join("\n")
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold text-foreground",
  2: "text-sm font-semibold text-foreground",
  3: "text-[13px] font-semibold text-foreground",
  4: "text-[13px] font-medium text-foreground",
  5: "text-[13px] font-medium text-foreground",
  6: "text-[13px] font-medium text-muted-foreground",
}

function Paragraph({ text, issueBase }: { text: string; issueBase?: string }) {
  const parts = text.split(/(?: {2,}|\\)\n/)
  return (
    <p>
      {parts.map((part, idx) => (
        <Fragment key={idx}>
          {idx > 0 && <br />}
          {renderInline(part.replace(/\n/g, " "), idx * 1000, issueBase)}
        </Fragment>
      ))}
    </p>
  )
}

function Blocks({
  blocks,
  issueBase,
}: {
  blocks: Block[]
  issueBase?: string
}) {
  return (
    <>
      {blocks.map((b, idx) => {
        switch (b.kind) {
          case "heading": {
            const Tag = `h${Math.min(b.level + 2, 6)}` as "h3"
            return (
              <Tag key={idx} className={HEADING_CLASS[b.level]}>
                {renderInline(b.text, 0, issueBase)}
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
          case "hr":
            return <hr key={idx} className="border-border" />
          case "quote":
            return (
              <blockquote
                key={idx}
                className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground"
              >
                <Blocks blocks={b.blocks} issueBase={issueBase} />
              </blockquote>
            )
          case "table":
            return (
              <div key={idx} className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      {b.header.map((c, j) => (
                        <th
                          key={j}
                          className="border-b border-border px-2 py-1 font-semibold text-foreground"
                          style={{ textAlign: b.align[j] as "left" }}
                        >
                          {renderInline(c, 0, issueBase)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border/60">
                        {b.header.map((_c, j) => (
                          <td
                            key={j}
                            className="px-2 py-1 align-top"
                            style={{ textAlign: b.align[j] as "left" }}
                          >
                            {renderInline(row[j] ?? "", 0, issueBase)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case "ul":
          case "ol": {
            const Tag = b.kind
            const tasks = b.items.some((it) => it.task !== undefined)
            return (
              <Tag
                key={idx}
                className={cn(
                  "space-y-1",
                  tasks
                    ? "list-none pl-1"
                    : b.kind === "ul"
                      ? "list-disc pl-5"
                      : "list-decimal pl-5"
                )}
              >
                {b.items.map((it, j) => (
                  <li key={j}>
                    {it.task !== undefined && (
                      <input
                        type="checkbox"
                        checked={it.task}
                        readOnly
                        tabIndex={-1}
                        className="mr-1.5 align-middle"
                        aria-label={it.task ? "done" : "to do"}
                      />
                    )}
                    {renderInline(it.text, 0, issueBase)}
                    {it.children && (
                      <div className="mt-1 space-y-1">
                        <Blocks blocks={it.children} issueBase={issueBase} />
                      </div>
                    )}
                  </li>
                ))}
              </Tag>
            )
          }
          default:
            return <Paragraph key={idx} text={b.text} issueBase={issueBase} />
        }
      })}
    </>
  )
}

export function Markdown({
  source,
  className,
  issueBase,
}: {
  source: string
  className?: string
  /** Where `#123` points, e.g. `https://github.com/org/repo/issues/`; without
   * it a reference stays plain text. */
  issueBase?: string
}) {
  const blocks = parseBlocks(source)
  return (
    <div
      className={cn(
        "space-y-2 text-[13px] leading-relaxed text-muted-foreground",
        className
      )}
    >
      <Blocks blocks={blocks} issueBase={issueBase} />
    </div>
  )
}
