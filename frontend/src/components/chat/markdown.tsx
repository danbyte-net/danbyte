import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"

/** Just enough Markdown for an answer, with no dependency and no HTML.
 *
 * Nothing here ever renders raw HTML, so there is no sanitiser to get
 * wrong: the text is split into blocks, and inline spans become React
 * elements. A link into Danbyte becomes a router Link, so clicking it does
 * not reload the app. */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2">{blocks(text)}</div>
}

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    if (line.trimStart().startsWith("```")) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i])
        i++
      }
      i++
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[12px] leading-relaxed"
        >
          {body.join("\n")}
        </pre>
      )
      continue
    }

    // table: a header row, a divider of dashes, then rows
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1])
    ) {
      const header = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(cells(lines[i]))
        i++
      }
      out.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-border">
                {header.map((h, n) => (
                  <th key={n} className="px-2 py-1 text-left font-medium">
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, n) => (
                <tr
                  key={n}
                  className="border-b border-border/60 last:border-b-0"
                >
                  {row.map((cell, m) => (
                    <td key={m} className="px-2 py-1 align-top">
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // list, bulleted or numbered
    const bullet = /^\s*[-*]\s+(.*)$/
    const numbered = /^\s*\d+[.)]\s+(.*)$/
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line)
      const items: string[] = []
      while (i < lines.length) {
        const match = (ordered ? numbered : bullet).exec(lines[i])
        if (!match) break
        items.push(match[1])
        i++
      }
      const List = ordered ? "ol" : "ul"
      out.push(
        <List
          key={key++}
          className={
            "space-y-0.5 pl-5 text-[13px] leading-relaxed " +
            (ordered ? "list-decimal" : "list-disc")
          }
        >
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </List>
      )
      continue
    }

    // heading
    const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      out.push(
        <p key={key++} className="text-[13px] font-semibold">
          {inline(heading[2])}
        </p>
      )
      i++
      continue
    }

    // paragraph: everything up to the next blank line
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== "") {
      const next = lines[i]
      if (
        next.trimStart().startsWith("```") ||
        bullet.test(next) ||
        numbered.test(next) ||
        /^\s*#{1,4}\s/.test(next)
      )
        break
      para.push(next)
      i++
    }
    if (para.length) {
      out.push(
        <p key={key++} className="text-[13px] leading-relaxed">
          {inline(para.join(" "))}
        </p>
      )
    } else {
      i++
    }
  }
  return out
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim())
}

/** Bold, italic, inline code and links, in one pass. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern =
    /(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g
  let last = 0
  let key = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith("[")) {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (parsed) out.push(link(parsed[1], parsed[2], key++))
    } else if (token.startsWith("`")) {
      out.push(
        <code
          key={key++}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]"
        >
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      )
    } else {
      out.push(
        <em key={key++} className="italic">
          {token.slice(1, -1)}
        </em>
      )
    }
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function link(label: string, href: string, key: number): ReactNode {
  // Inside Danbyte: a router link, so the app does not reload.
  if (href.startsWith("/")) {
    return (
      <Link key={key} to={href} className="link">
        {label}
      </Link>
    )
  }
  if (/^https?:\/\//.test(href)) {
    return (
      <a
        key={key}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="link"
      >
        {label}
      </a>
    )
  }
  return <span key={key}>{label}</span>
}
