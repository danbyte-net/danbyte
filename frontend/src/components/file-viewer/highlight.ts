import {
  HighlightStyle,
  StreamLanguage,
  StringStream,
  syntaxHighlighting,
} from "@codemirror/language"
import type { StreamParser } from "@codemirror/language"
import type { Extension } from "@codemirror/state"
import { Tag, tags as t } from "@lezer/highlight"

// Small line tokenizers for the file viewer's colouring. Each reads a line
// left to right, one token per call, with regexes that cannot backtrack
// (anchored, no nested or overlapping quantifiers), so a 20k-line file
// costs one pass.

/** What the viewer colours a text as. */
export type Highlight =
  "json" | "xml" | "yaml" | "ini" | "netconf" | "log" | "text"

// ─── Shared word matching ────────────────────────────────────────────────
const WORD = /^[\w.:/-]+/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/
const NUMBER = /^-?\d+(?:\.\d+)?$/
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/

/** IPv6 addresses and prefixes (with an optional IPv4 tail), and MACs. */
export function isIpv6(word: string): boolean {
  const slash = word.indexOf("/")
  let addr = word
  if (slash >= 0) {
    if (!/^\d{1,3}$/.test(word.slice(slash + 1))) return false
    addr = word.slice(0, slash)
  }
  const parts = addr.split(":")
  if (parts.length < 3 || parts.length > 9) return false
  let empty = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === "") {
      empty++
      continue
    }
    if (i === parts.length - 1 && IPV4.test(p) && !p.includes("/")) continue
    if (!HEX_GROUP.test(p)) return false
  }
  // `::` makes at most two empty parts (three for a bare `::`).
  return empty <= 3 && !(empty > 0 && !addr.includes("::"))
}

function addressOrNumber(word: string): string | null {
  if (IPV4.test(word) || isIpv6(word)) return "address"
  if (NUMBER.test(word)) return "number"
  return null
}

function readQuoted(stream: StringStream, quote: string): void {
  // Opening quote already consumed. Stops at the closing quote or the end.
  let ch: string | void
  while ((ch = stream.next()) != null) {
    if (ch === "\\") stream.next()
    else if (ch === quote) return
  }
}

// ─── JSON ─────────────────────────────────────────────────────────────────
const JSON_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/

export const jsonParser: StreamParser<object> = {
  name: "json",
  token(stream) {
    if (stream.eatSpace()) return null
    const ch = stream.peek()
    if (ch === '"') {
      stream.next()
      readQuoted(stream, '"')
      return stream.match(/^\s*:/, false) ? "propertyName" : "string"
    }
    if (stream.match(JSON_NUMBER)) return "number"
    if (stream.match(/^(?:true|false)\b/)) return "bool"
    if (stream.match(/^null\b/)) return "null"
    stream.next()
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]") return "bracket"
    if (ch === "," || ch === ":") return "punctuation"
    return null
  },
}

// ─── XML / HTML ───────────────────────────────────────────────────────────
interface XmlState {
  /** text, inside a tag, a comment, CDATA, or a `<!…>` declaration. */
  ctx: "text" | "tag" | "comment" | "cdata" | "decl"
  /** The next name in a tag is its tag name. */
  name: boolean
  /** An attribute value still open from an earlier line. */
  quote: string | null
}

function skipPast(stream: StringStream, end: string): boolean {
  if (stream.skipTo(end)) {
    stream.pos += end.length
    return true
  }
  stream.skipToEnd()
  return false
}

export const xmlParser: StreamParser<XmlState> = {
  name: "xml",
  startState: () => ({ ctx: "text", name: false, quote: null }),
  token(stream, s) {
    if (s.ctx === "comment") {
      if (skipPast(stream, "-->")) s.ctx = "text"
      return "comment"
    }
    if (s.ctx === "cdata") {
      if (skipPast(stream, "]]>")) s.ctx = "text"
      return "string.special"
    }
    if (s.ctx === "decl") {
      if (skipPast(stream, ">")) s.ctx = "text"
      return "meta"
    }
    if (s.ctx === "tag") {
      if (s.quote) {
        const q = s.quote
        if (skipPast(stream, q)) s.quote = null
        return "attributeValue"
      }
      if (stream.eatSpace()) return null
      if (stream.match("/>") || stream.match("?>") || stream.eat(">")) {
        s.ctx = "text"
        return "angleBracket"
      }
      if (stream.match(/^[\w:.-]+/)) {
        if (s.name) {
          s.name = false
          return "tagName"
        }
        return "attributeName"
      }
      if (stream.eat("=")) return "operator"
      const q = stream.peek()
      if (q === '"' || q === "'") {
        stream.next()
        if (!skipPast(stream, q)) s.quote = q
        return "attributeValue"
      }
      stream.next()
      return null
    }
    // Text between tags.
    if (stream.match("<!--")) {
      s.ctx = "comment"
      if (skipPast(stream, "-->")) s.ctx = "text"
      return "comment"
    }
    if (stream.match("<![CDATA[")) {
      s.ctx = "cdata"
      if (skipPast(stream, "]]>")) s.ctx = "text"
      return "string.special"
    }
    if (stream.match("<!")) {
      s.ctx = "decl"
      if (skipPast(stream, ">")) s.ctx = "text"
      return "meta"
    }
    if (stream.match(/^<[/?]?(?=[\w:])/)) {
      s.ctx = "tag"
      s.name = true
      return "angleBracket"
    }
    if (stream.match(/^&(?:#\d+|#x[0-9a-fA-F]+|\w+);/)) return "character"
    if (!stream.match(/^[^<&]+/)) stream.next()
    return null
  },
}

// ─── YAML ─────────────────────────────────────────────────────────────────
interface YamlState {
  /** Indentation of the line that opened a `|` or `>` block, or -1. */
  block: number
  /** A key may start here: at the line's start or after `- `. */
  keyOk: boolean
}

const YAML_NUMBER =
  /^[-+]?(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.inf|\.nan)(?=$|[\s,\]}])/i
const YAML_BOOL = /^(?:true|false|yes|no|on|off)(?=$|[\s,\]}])/i
const YAML_NULL = /^(?:null|~)(?=$|[\s,\]}])/i

export const yamlParser: StreamParser<YamlState> = {
  name: "yaml",
  startState: () => ({ block: -1, keyOk: true }),
  token(stream, s) {
    if (stream.sol()) {
      s.keyOk = true
      if (s.block >= 0) {
        if (stream.indentation() > s.block) {
          stream.skipToEnd()
          return "string"
        }
        s.block = -1
      }
      if (stream.match(/^(?:---|\.\.\.)(?=\s|$)/)) return "meta"
    }
    if (stream.eatSpace()) return null
    const ch = stream.peek()!
    const prev = stream.pos === 0 ? " " : stream.string[stream.pos - 1]
    if (ch === "#" && /\s/.test(prev)) {
      stream.skipToEnd()
      return "comment"
    }
    if (
      ch === "-" &&
      s.keyOk &&
      /^-(?:\s|$)/.test(stream.string.slice(stream.pos, stream.pos + 2))
    ) {
      stream.next()
      return "punctuation"
    }
    const wasKey = s.keyOk
    s.keyOk = false
    if (ch === '"' || ch === "'") {
      stream.next()
      readQuoted(stream, ch)
      return wasKey && stream.match(/^\s*:(?=\s|$)/, false)
        ? "propertyName"
        : "string"
    }
    if (wasKey) {
      // A plain key runs to the first `:` followed by a space or the end.
      const rest = stream.string.slice(stream.pos)
      const m = /^[^:#]+/.exec(rest)
      if (
        m &&
        rest[m[0].length] === ":" &&
        /^(?:\s|$)/.test(rest.slice(m[0].length + 1, m[0].length + 2))
      ) {
        stream.pos += m[0].trimEnd().length
        return "propertyName"
      }
    }
    if (ch === ":") {
      stream.next()
      return "punctuation"
    }
    if ("{}[],".includes(ch)) {
      stream.next()
      return "bracket"
    }
    if ((ch === "|" || ch === ">") && stream.match(/^[|>][-+0-9]*\s*(?=$|#)/)) {
      s.block = stream.indentation()
      return "operator"
    }
    if (ch === "&" || ch === "*" || ch === "!") {
      stream.match(/^[&*!][^\s,\]}]*/)
      return "meta"
    }
    if (stream.match(YAML_NUMBER)) return "number"
    if (stream.match(YAML_BOOL)) return "bool"
    if (stream.match(YAML_NULL)) return "null"
    if (!stream.match(/^[^\s,\]}]+/)) stream.next()
    return "string"
  },
}

// ─── INI / systemd units ──────────────────────────────────────────────────
interface LineState {
  /** The next word is the line's first. */
  first: boolean
  /** The line had its `key=`; what follows is the value. */
  value: boolean
}

const INI_BOOL = /^(?:yes|no|true|false|on|off)$/i

export const iniParser: StreamParser<LineState> = {
  name: "ini",
  startState: () => ({ first: true, value: false }),
  token(stream, s) {
    if (stream.sol()) {
      s.first = true
      s.value = false
    }
    if (stream.eatSpace()) return null
    const ch = stream.peek()!
    if (s.first && (ch === "#" || ch === ";")) {
      stream.skipToEnd()
      return "comment"
    }
    if (s.first && ch === "[" && stream.match(/^\[[^\]]*\]/)) {
      s.first = false
      return "heading"
    }
    if (s.first) {
      s.first = false
      const rest = stream.string.slice(stream.pos)
      const m = /^[^=]+/.exec(rest)
      if (m && rest[m[0].length] === "=") {
        stream.pos += m[0].trimEnd().length
        return "propertyName"
      }
    }
    if (ch === "=" && !s.value) {
      stream.next()
      s.value = true
      return "operator"
    }
    if (stream.match(WORD)) {
      const w = stream.current()
      return addressOrNumber(w) ?? (INI_BOOL.test(w) ? "bool" : null)
    }
    stream.next()
    return null
  },
}

// ─── Network config: FRR, IOS-like, ifupdown ──────────────────────────────
const NET_KEYWORDS = new Set([
  "interface",
  "router",
  "vrf",
  "address-family",
  "iface",
  "auto",
  "allow-hotplug",
  "line",
  "exit",
  "exit-vrf",
  "exit-address-family",
  "end",
])

export const netconfParser: StreamParser<LineState> = {
  name: "netconf",
  startState: () => ({ first: true, value: false }),
  token(stream, s) {
    if (stream.sol()) s.first = true
    if (stream.eatSpace()) return null
    const ch = stream.peek()!
    if (s.first && (ch === "!" || ch === "#")) {
      stream.skipToEnd()
      return "comment"
    }
    const first = s.first
    s.first = false
    if (stream.match(WORD)) {
      const w = stream.current()
      if (first && NET_KEYWORDS.has(w)) return "keyword"
      return addressOrNumber(w)
    }
    if (ch === '"') {
      stream.next()
      readQuoted(stream, '"')
      return "string"
    }
    stream.next()
    return null
  },
}

// ─── Logs ─────────────────────────────────────────────────────────────────
const LOG_STAMP =
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\]?/
const LOG_TIME = /^\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?(?![\w:])/
const LOG_EXIT = /^exit(?:ed)?(?: with)?(?: code| status)?[ :=]+(\d+)/i
const LOG_ERROR = new Set([
  "error",
  "errors",
  "err",
  "failed",
  "failure",
  "fail",
  "fatal",
  "panic",
  "critical",
  "exception",
  "traceback",
  "unreachable",
])
const LOG_WARN = new Set(["warn", "warning", "warnings", "deprecated"])
const LOG_OK = new Set([
  "ok",
  "succeeded",
  "success",
  "successful",
  "successfully",
  "passed",
])

export const logParser: StreamParser<object> = {
  name: "log",
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match(LOG_STAMP) || stream.match(LOG_TIME)) return "timestamp"
    const exit = stream.match(LOG_EXIT) as RegExpMatchArray | null
    if (exit) return exit[1] === "0" ? "logOk" : "logError"
    if (stream.match(/^[A-Za-z][\w-]*/)) {
      const w = stream.current().toLowerCase()
      const kind = LOG_ERROR.has(w)
        ? "logError"
        : LOG_WARN.has(w)
          ? "logWarn"
          : LOG_OK.has(w)
            ? "logOk"
            : null
      // Counters such as Ansible's `failed=0` are not failures.
      if (kind && kind !== "logOk" && stream.match(/^[=:] ?0(?!\d)/, false))
        return null
      return kind
    }
    if (!stream.match(/^\d+/) && !stream.match(/^[^\sA-Za-z\d]+/)) stream.next()
    return null
  },
}

// ─── Picking a language ───────────────────────────────────────────────────
const BY_EXT: Record<string, Highlight> = {
  json: "json",
  geojson: "json",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xsd: "xml",
  xsl: "xml",
  xslt: "xml",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  network: "ini",
  netdev: "ini",
  link: "ini",
  service: "ini",
  socket: "ini",
  timer: "ini",
  mount: "ini",
  target: "ini",
  path: "ini",
  log: "log",
}
const TEMPLATE_EXT = /\.(?:j2|jinja2?|tmpl|tpl)$/i

/** The language a file name says, or null when it does not say. */
export function highlightFromName(name: string | undefined): Highlight | null {
  if (!name) return null
  const base = (name.split("/").pop() ?? name).replace(TEMPLATE_EXT, "")
  const lower = base.toLowerCase()
  if (lower === "interfaces" || lower === "frr.conf" || lower === "daemons")
    return "netconf"
  const dot = lower.lastIndexOf(".")
  if (dot <= 0) return null
  return BY_EXT[lower.slice(dot + 1)] ?? null
}

const INI_HEAD = /^\[[A-Za-z][\w .-]*\]\s*$/

/** A cheap guess from the first meaningful line. */
export function sniffHighlight(text: string): Highlight | null {
  const head = text.slice(0, 4000)
  const lines = head.split("\n")
  for (const raw of lines) {
    const l = raw.trim()
    if (l === "") continue
    if (INI_HEAD.test(l)) return "ini"
    if (l.startsWith("{") || l.startsWith("[")) return "json"
    if (l.startsWith("<?xml") || /^<[A-Za-z!]/.test(l)) return "xml"
    if (l.startsWith("#") || l.startsWith(";") || l.startsWith("!")) continue
    if (l === "---" || /^[\w.-]+:(?:\s|$)/.test(l) || /^- /.test(l))
      return "yaml"
    return null
  }
  return null
}

/** What to colour a text as: an explicit language wins, then the file
 * name, then a look at the text. `fallback` covers the rest. */
export function pickHighlight(opts: {
  language?: Highlight | "auto"
  name?: string
  text: string
  fallback?: Highlight
}): Highlight {
  if (opts.language && opts.language !== "auto") return opts.language
  return (
    highlightFromName(opts.name) ??
    sniffHighlight(opts.text) ??
    opts.fallback ??
    "text"
  )
}

// ─── Editor extensions ────────────────────────────────────────────────────
const timestampTag = Tag.define()
const addressTag = Tag.define()
const logErrorTag = Tag.define()
const logWarnTag = Tag.define()
const logOkTag = Tag.define()

const TOKEN_TABLE = {
  timestamp: timestampTag,
  address: addressTag,
  logError: logErrorTag,
  logWarn: logWarnTag,
  logOk: logOkTag,
}

const PARSERS: Record<Exclude<Highlight, "text">, StreamParser<unknown>> = {
  json: jsonParser,
  xml: xmlParser,
  yaml: yamlParser,
  ini: iniParser,
  netconf: netconfParser,
  log: logParser,
}

// Colours come from the --syntax-* tokens in styles.css (both themes).
export const syntaxStyle = HighlightStyle.define([
  {
    tag: [t.propertyName, t.tagName, t.keyword, t.heading],
    color: "var(--syntax-key)",
  },
  {
    tag: [t.string, t.attributeValue, t.special(t.string), addressTag],
    color: "var(--syntax-string)",
  },
  {
    tag: [t.number, t.bool, t.null, t.attributeName, t.character],
    color: "var(--syntax-number)",
  },
  {
    tag: [
      t.comment,
      t.meta,
      t.punctuation,
      t.bracket,
      t.angleBracket,
      t.operator,
      timestampTag,
    ],
    color: "var(--muted-foreground)",
  },
  { tag: logErrorTag, color: "var(--destructive)", fontWeight: "600" },
  { tag: logWarnTag, color: "var(--syntax-warn)", fontWeight: "600" },
  { tag: logOkTag, color: "var(--syntax-ok)" },
])

const cache = new Map<Highlight, Extension>()

/** The colouring for `lang`; one shared instance per language, so a new
 * text does not rebuild the language. */
export function syntaxFor(lang: Highlight): Extension {
  if (lang === "text") return []
  let ext = cache.get(lang)
  if (!ext) {
    const p = PARSERS[lang]
    ext = [
      StreamLanguage.define({ ...p, tokenTable: TOKEN_TABLE }),
      syntaxHighlighting(syntaxStyle),
    ]
    cache.set(lang, ext)
  }
  return ext
}

// ─── Testing aid ──────────────────────────────────────────────────────────
/** Run a parser over `text` the way the editor does, one line at a time.
 * Returns each line's styled tokens as [text, style] pairs. */
export function tokenize(
  lang: Exclude<Highlight, "text">,
  text: string
): [string, string][][] {
  const p = PARSERS[lang]
  const state = p.startState ? p.startState(2) : {}
  const out: [string, string][][] = []
  for (const line of text.split("\n")) {
    const toks: [string, string][] = []
    if (line === "") p.blankLine?.(state, 2)
    const stream = new StringStream(line, 4, 2)
    while (!stream.eol()) {
      stream.start = stream.pos
      const style = p.token(stream, state)
      if (stream.pos === stream.start) throw new Error(`${lang}: no progress`)
      if (style) toks.push([stream.current(), style])
    }
    out.push(toks)
  }
  return out
}
