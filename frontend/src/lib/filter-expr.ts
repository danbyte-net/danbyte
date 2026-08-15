// The advanced-filter expression engine: one AST, edited two ways (typed
// grammar and visual builder), evaluated client-side over the rows a list has
// already loaded — the same rows the facet rail filters.
//
// Grammar (case-insensitive keywords, `and` binds tighter than `or`):
//
//   expr    := term ("or" term)*
//   term    := clause ("and" clause)*
//   clause  := "(" expr ")" | field cmp value | field "is" ["not"] "empty"
//   cmp     := "=" | "!=" | "~" | "!~" | ">" | "<" | ">=" | "<="
//   field   := dotted identifier            e.g. status.name, due_date, tags
//   value   := "quoted string" | bare-word | number
//
//   status.name = active and (site.name ~ "cph" or tags ~ core)
//
// Comparison semantics: string compares are case-insensitive; `~` is
// substring containment; `>`/`<` compare numerically when both sides are
// numeric, else lexically (which makes ISO dates work). A path that lands on
// an object compares against its `name`/`slug`/`title`; a path that lands on
// an array matches when ANY element does.

// ─── AST ────────────────────────────────────────────────────────────────

export type Cmp = "=" | "!=" | "~" | "!~" | ">" | "<" | ">=" | "<="

export type Expr =
  | { kind: "group"; op: "and" | "or"; terms: Expr[] }
  | { kind: "cmp"; field: string; cmp: Cmp; value: string }
  | { kind: "empty"; field: string; negated: boolean }

export const CMP_LABELS: Record<Cmp, string> = {
  "=": "is",
  "!=": "is not",
  "~": "contains",
  "!~": "doesn't contain",
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
}

// ─── Tokenizer ──────────────────────────────────────────────────────────

type Token =
  | { t: "word"; v: string; pos: number }
  | { t: "string"; v: string; pos: number }
  | { t: "cmp"; v: Cmp; pos: number }
  | { t: "("; pos: number }
  | { t: ")"; pos: number }

const WORD_RE = /^[A-Za-z0-9_.@+/:-]+/

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === " " || c === "\t" || c === "\n") {
      i++
      continue
    }
    if (c === "(" || c === ")") {
      out.push({ t: c, pos: i })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1)
      if (end === -1) throw new ParseError("Unclosed quote", i)
      out.push({ t: "string", v: src.slice(i + 1, end), pos: i })
      i = end + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === "!=" || two === "!~" || two === ">=" || two === "<=") {
      out.push({ t: "cmp", v: two as Cmp, pos: i })
      i += 2
      continue
    }
    if (c === "=" || c === "~" || c === ">" || c === "<") {
      out.push({ t: "cmp", v: c as Cmp, pos: i })
      i++
      continue
    }
    const m = WORD_RE.exec(src.slice(i))
    if (!m) throw new ParseError(`Unexpected character "${c}"`, i)
    out.push({ t: "word", v: m[0], pos: i })
    i += m[0].length
  }
  return out
}

export class ParseError extends Error {
  pos: number
  constructor(message: string, pos: number) {
    super(message)
    this.pos = pos
  }
}

// ─── Parser (recursive descent) ─────────────────────────────────────────

export function parse(src: string): Expr | null {
  if (!src.trim()) return null
  const tokens = tokenize(src)
  let i = 0

  const peek = () => tokens[i]
  const isWord = (v: string) =>
    peek()?.t === "word" && (peek() as { v: string }).v.toLowerCase() === v

  function expr(): Expr {
    const terms = [term()]
    while (isWord("or")) {
      i++
      terms.push(term())
    }
    return terms.length === 1 ? terms[0] : { kind: "group", op: "or", terms }
  }

  function term(): Expr {
    const terms = [clause()]
    while (isWord("and")) {
      i++
      terms.push(clause())
    }
    return terms.length === 1 ? terms[0] : { kind: "group", op: "and", terms }
  }

  function clause(): Expr {
    const tok = peek()
    if (!tok) throw new ParseError("Expected a condition", src.length)
    if (tok.t === "(") {
      i++
      const inner = expr()
      if (peek()?.t !== ")") throw new ParseError('Expected ")"', tok.pos)
      i++
      return inner
    }
    if (tok.t !== "word") throw new ParseError("Expected a field name", tok.pos)
    const field = tok.v
    i++
    // "field is [not] empty" — the wordy form the builder writes.
    if (isWord("is")) {
      const save = i
      i++
      let negated = false
      if (isWord("not")) {
        negated = true
        i++
      }
      if (isWord("empty")) {
        i++
        return { kind: "empty", field, negated }
      }
      i = save // plain "is" → treat as "=" sugar below
    }
    const op = peek()
    if (op?.t === "word" && op.v.toLowerCase() === "is") {
      i++
      if (isWord("not")) {
        i++
        return { kind: "cmp", field, cmp: "!=", value: value() }
      }
      return { kind: "cmp", field, cmp: "=", value: value() }
    }
    if (op?.t !== "cmp")
      throw new ParseError(
        `Expected an operator after "${field}"`,
        op?.pos ?? src.length
      )
    i++
    return { kind: "cmp", field, cmp: op.v, value: value() }
  }

  function value(): string {
    const tok = peek()
    if (!tok || (tok.t !== "word" && tok.t !== "string"))
      throw new ParseError("Expected a value", tok?.pos ?? src.length)
    i++
    return tok.v
  }

  const result = expr()
  if (i < tokens.length)
    throw new ParseError("Unexpected trailing input", tokens[i].pos)
  return result
}

// ─── Formatter (canonical text — what the builder writes) ───────────────

function quoteIfNeeded(v: string): string {
  return /^[A-Za-z0-9_.@+/:-]+$/.test(v) && v !== "" ? v : `"${v}"`
}

export function format(expr: Expr | null, parent?: "and" | "or"): string {
  if (!expr) return ""
  if (expr.kind === "cmp")
    return `${expr.field} ${expr.cmp} ${quoteIfNeeded(expr.value)}`
  if (expr.kind === "empty")
    return `${expr.field} is ${expr.negated ? "not " : ""}empty`
  const inner = expr.terms.map((t) => format(t, expr.op)).join(` ${expr.op} `)
  // Parenthesise an OR living inside an AND — the only precedence hazard.
  return parent === "and" && expr.op === "or" ? `(${inner})` : inner
}

// ─── Evaluation ─────────────────────────────────────────────────────────

/** The comparable value(s) at a dotted path. Objects yield their
 * name/slug/title; arrays fan out to every element's value. */
function valuesAt(row: unknown, path: string): unknown[] {
  let current: unknown[] = [row]
  for (const key of path.split(".")) {
    const next: unknown[] = []
    for (const v of current) {
      if (v === null || v === undefined) continue
      if (Array.isArray(v)) {
        for (const el of v)
          if (el && typeof el === "object")
            next.push((el as Record<string, unknown>)[key])
          else next.push(undefined)
      } else if (typeof v === "object") {
        next.push((v as Record<string, unknown>)[key])
      }
    }
    current = next
  }
  // Terminal objects/arrays flatten to displayable scalars.
  const out: unknown[] = []
  for (const v of current) {
    if (Array.isArray(v)) {
      for (const el of v) out.push(scalarOf(el))
    } else {
      out.push(scalarOf(v))
    }
  }
  return out
}

function scalarOf(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    return o.name ?? o.slug ?? o.title ?? o.username ?? undefined
  }
  return v
}

function compare(actual: unknown, cmp: Cmp, wanted: string): boolean {
  if (actual === null || actual === undefined || actual === "") return false
  if (typeof actual === "boolean") {
    const w = wanted.toLowerCase()
    const b = w === "true" || w === "yes" || w === "1"
    return cmp === "=" ? actual === b : cmp === "!=" ? actual !== b : false
  }
  const a = String(actual)
  const numeric = !Number.isNaN(Number(a)) && !Number.isNaN(Number(wanted))
  switch (cmp) {
    case "=":
      return a.toLowerCase() === wanted.toLowerCase()
    case "!=":
      return a.toLowerCase() !== wanted.toLowerCase()
    case "~":
      return a.toLowerCase().includes(wanted.toLowerCase())
    case "!~":
      return !a.toLowerCase().includes(wanted.toLowerCase())
    case ">":
      return numeric ? Number(a) > Number(wanted) : a > wanted
    case "<":
      return numeric ? Number(a) < Number(wanted) : a < wanted
    case ">=":
      return numeric ? Number(a) >= Number(wanted) : a >= wanted
    case "<=":
      return numeric ? Number(a) <= Number(wanted) : a <= wanted
  }
}

export function evaluate(expr: Expr, row: unknown): boolean {
  if (expr.kind === "group") {
    return expr.op === "and"
      ? expr.terms.every((t) => evaluate(t, row))
      : expr.terms.some((t) => evaluate(t, row))
  }
  const values = valuesAt(row, expr.field)
  if (expr.kind === "empty") {
    const has = values.some(
      (v) => v !== null && v !== undefined && v !== "" && v !== false
    )
    return expr.negated ? has : !has
  }
  // Negative comparisons must hold for every element ("tags !~ core" means no
  // tag contains it); positive ones for any.
  if (expr.cmp === "!=" || expr.cmp === "!~") {
    if (values.length === 0) return true
    return values.every((v) => compare(v, expr.cmp, expr.value))
  }
  return values.some((v) => compare(v, expr.cmp, expr.value))
}

// ─── Field discovery (for the builder + completion) ─────────────────────

export interface FieldInfo {
  path: string
  kind: "string" | "number" | "boolean"
  /** Distinct sample values (≤ 12) for the builder's value suggestions. */
  samples: string[]
}

const SKIP_KEYS = new Set([
  "id",
  "numid",
  "permissions",
  "created_at",
  "updated_at",
])

/** Derive the filterable field paths from the rows themselves (two levels
 * deep, name-bearing objects surfaced under their own key), so the builder
 * needs no per-model registry — like the facet rail, it describes exactly the
 * list it sits on. */
export function discoverFields(rows: unknown[]): FieldInfo[] {
  const found = new Map<
    string,
    { kind: FieldInfo["kind"]; samples: Set<string> }
  >()
  const note = (path: string, v: unknown) => {
    const scalar = scalarOf(v)
    if (scalar === null || scalar === undefined) return
    const kind =
      typeof scalar === "number"
        ? "number"
        : typeof scalar === "boolean"
          ? "boolean"
          : "string"
    let entry = found.get(path)
    if (!entry) {
      entry = { kind, samples: new Set() }
      found.set(path, entry)
    }
    if (entry.samples.size < 50 && typeof scalar !== "boolean")
      entry.samples.add(String(scalar))
  }
  for (const row of rows.slice(0, 200)) {
    if (!row || typeof row !== "object") continue
    for (const [key, v] of Object.entries(row as Record<string, unknown>)) {
      if (SKIP_KEYS.has(key) || key.endsWith("_id")) continue
      if (v === null || v === undefined) continue
      if (Array.isArray(v)) {
        for (const el of v.slice(0, 5)) note(key, el)
      } else if (typeof v === "object") {
        note(key, v) // the object itself (name/slug)
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          if (SKIP_KEYS.has(k2) || k2.endsWith("_id")) continue
          if (v2 !== null && typeof v2 !== "object") note(`${key}.${k2}`, v2)
        }
      } else {
        note(key, v)
      }
    }
  }
  return [...found.entries()]
    .map(([path, e]) => ({
      path,
      kind: e.kind,
      samples: [...e.samples].sort(),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

// ─── Builder-friendly view of an AST ────────────────────────────────────

export interface BuilderRule {
  field: string
  cmp: Cmp | "empty" | "not_empty"
  value: string
}

/** A flat (single-combinator) view of the AST, or null when the expression
 * uses nesting the builder can't show — the text editor still can. */
export function toBuilder(
  expr: Expr | null
): { op: "and" | "or"; rules: BuilderRule[] } | null {
  const ruleOf = (e: Expr): BuilderRule | null => {
    if (e.kind === "cmp") return { field: e.field, cmp: e.cmp, value: e.value }
    if (e.kind === "empty")
      return {
        field: e.field,
        cmp: e.negated ? "not_empty" : "empty",
        value: "",
      }
    return null
  }
  if (!expr) return { op: "and", rules: [] }
  const single = ruleOf(expr)
  if (single) return { op: "and", rules: [single] }
  if (expr.kind !== "group") return null
  const rules: BuilderRule[] = []
  for (const t of expr.terms) {
    const r = ruleOf(t)
    if (!r) return null
    rules.push(r)
  }
  return { op: expr.op, rules }
}

export function fromBuilder(
  op: "and" | "or",
  rules: BuilderRule[]
): Expr | null {
  const terms: Expr[] = rules
    .filter((r) => r.field)
    .map((r) =>
      r.cmp === "empty" || r.cmp === "not_empty"
        ? {
            kind: "empty" as const,
            field: r.field,
            negated: r.cmp === "not_empty",
          }
        : { kind: "cmp" as const, field: r.field, cmp: r.cmp, value: r.value }
    )
  if (terms.length === 0) return null
  return terms.length === 1 ? terms[0] : { kind: "group", op, terms }
}
