/** The plain text of a type description that still carries Markdown links
 * (`[Data Sheet](https://…)`, `<https://…>`), as the community device type
 * library writes them. The text twin of `api/description_links.py` `split`:
 * a description of nothing but links (plus bullets and separators) is `""`,
 * otherwise each link shows as its label (an autolink as its URL) with the
 * whitespace tidied. Images and non-http(s) links stay as written; text
 * with no link comes back unchanged. Display only - the import and the
 * `description_links` command move the links to the type's Documents. */

const NUMBERING = /^\s*\d+[.)]\s+/gm
const ONLY_SEPARATORS = /^[\s\-*+•·|,;/.]*$/

function isHttp(url: string): boolean {
  return /^https?:\/\/\S/i.test(url)
}

/** Index of the `]` closing a label opened at `i`, or -1. */
function labelEnd(text: string, i: number): number {
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === "\n" && text[j + 1] === "\n") return -1
    if (c === "[") depth++
    else if (c === "]" && --depth === 0) return j
  }
  return -1
}

/** Index just past the `)` closing a destination starting at `i`, or -1. */
function urlEnd(text: string, i: number): number {
  let depth = 0
  let j = i
  while (j < text.length && !" \t\n".includes(text[j])) {
    const c = text[j]
    if (c === "(") depth++
    else if (c === ")") {
      if (depth === 0) return j + 1
      depth--
    }
    j++
  }
  while (j < text.length && " \t".includes(text[j])) j++
  if (j < text.length && "\"'".includes(text[j])) {
    const close = text.indexOf(text[j], j + 1)
    if (close < 0 || text.slice(j, close).includes("\n")) return -1
    j = close + 1
    while (j < text.length && " \t".includes(text[j])) j++
  }
  return text[j] === ")" ? j + 1 : -1
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function plainDescription(text: string | null | undefined): string {
  const src = text ?? ""
  let out = ""
  let bare = ""
  let found = false
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "!" && src[i + 1] === "[") {
      const end = labelEnd(src, i + 1)
      const close = end >= 0 && src[end + 1] === "(" ? urlEnd(src, end + 2) : -1
      const chunk = close >= 0 ? src.slice(i, close) : c
      out += chunk
      bare += chunk
      i += chunk.length
      continue
    }
    if (c === "[") {
      const end = labelEnd(src, i)
      const close = end >= 0 && src[end + 1] === "(" ? urlEnd(src, end + 2) : -1
      if (close >= 0) {
        const url =
          src
            .slice(end + 2, close - 1)
            .trim()
            .split(/\s+/)[0] ?? ""
        if (isHttp(url)) {
          found = true
          out += src
            .slice(i + 1, end)
            .split(/\s+/)
            .filter(Boolean)
            .join(" ")
        } else {
          out += src.slice(i, close)
          bare += src.slice(i, close)
        }
        i = close
        continue
      }
    }
    if (c === "<") {
      const close = src.indexOf(">", i + 1)
      const url = close > 0 ? src.slice(i + 1, close) : ""
      if (isHttp(url) && !/\s/.test(url)) {
        found = true
        out += url
        i = close + 1
        continue
      }
    }
    out += c
    bare += c
    i++
  }
  if (!found) return src
  if (ONLY_SEPARATORS.test(bare.replace(NUMBERING, ""))) return ""
  return tidy(out)
}
