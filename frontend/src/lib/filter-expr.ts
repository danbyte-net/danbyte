// The advanced-filter expression engine: one AST, edited two ways (typed
// grammar and visual builder), evaluated client-side over the rows a list has
// already loaded - the same rows the facet rail filters.
//
// Grammar (case-insensitive keywords, `and` binds tighter than `or`):
//
//   expr    := term ("or" term)*
//   term    := clause ("and" clause)*
//   clause  := "(" expr ")" | field cmp value | field "is" ["not"] "empty"
//            | field ["not"] "in" "(" value ("," value)* ")"
//            | field ["not"] "matches" value
//   cmp     := "=" | "!=" | "~" | "!~" | ">" | "<" | ">=" | "<="
//   field   := dotted identifier            e.g. status.name, due_date, tags
//   value   := "quoted string" | bare-word | number
//
//   status.name = active and (site.name ~ "cph" or tags in (core, edge))
//
// Comparison semantics: string compares are case-insensitive; `~` is
// substring containment; `in` is equality with any listed value; `matches`
// is a regular expression (case-sensitive, like PostgreSQL's `~`); `>`/`<`
// compare numerically when both sides are numeric, else lexically (which
// makes ISO dates work). A path that lands on an object compares against its
// `name`/`slug`/`title`; a path that lands on an array matches when ANY
// element does, and a negative comparison only when EVERY element does.
//
// The same AST is a compliance rule's scope and conditions, compiled to SQL
// by core/expressions.py. There, `in` values are ids.

// ─── AST ────────────────────────────────────────────────────────────────

export type Cmp = "=" | "!=" | "~" | "!~" | ">" | "<" | ">=" | "<="
/** Regular-expression comparisons. */
export type RegexCmp = "matches" | "not_matches"
/** Comparisons against a list of values. */
export type ListCmp = "in" | "not_in"
export type ScalarCmp = Cmp | RegexCmp

export type Expr =
  | { kind: "group"; op: "and" | "or"; terms: Expr[] }
  | { kind: "cmp"; field: string; cmp: ScalarCmp; value: string }
  | { kind: "cmp"; field: string; cmp: ListCmp; values: string[] }
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

/** Every operator the builder offers, by its id. */
export type BuilderOp = Cmp | RegexCmp | ListCmp | "empty" | "not_empty"

export const OP_LABELS: Record<BuilderOp, string> = {
  ...CMP_LABELS,
  in: "is any of",
  not_in: "is none of",
  matches: "matches",
  not_matches: "doesn't match",
  empty: "is empty",
  not_empty: "is not empty",
}

export type ListExpr = Extract<Expr, { cmp: ListCmp }>
export type ScalarExpr = Extract<Expr, { cmp: ScalarCmp }>

/** An `in` / `not in` comparison. */
export const isListExpr = (e: Expr): e is ListExpr =>
  e.kind === "cmp" && (e.cmp === "in" || e.cmp === "not_in")

export const isListOp = (op: string): op is ListCmp =>
  op === "in" || op === "not_in"
export const isEmptyOp = (op: string) => op === "empty" || op === "not_empty"

// ─── Tokenizer ──────────────────────────────────────────────────────────

type Token =
  | { t: "word"; v: string; pos: number }
  | { t: "string"; v: string; pos: number }
  | { t: "cmp"; v: Cmp; pos: number }
  | { t: "("; pos: number }
  | { t: ")"; pos: number }
  | { t: ","; pos: number }

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
    if (c === "(" || c === ")" || c === ",") {
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

/** Top-level lines: newlines outside parentheses and quotes separate
 * conditions, so "one condition per line" reads as an implicit `and`. */
function topLevelLines(src: string): string[] {
  const lines: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "\n" && depth === 0) {
      lines.push(src.slice(start, i))
      start = i + 1
    }
  }
  lines.push(src.slice(start))
  return lines.map((l) => l.trim()).filter(Boolean)
}

export function parse(src: string): Expr | null {
  if (!src.trim()) return null
  // Multi-line input: each line is a condition, lines combine with `and`.
  // Parenthesising each line keeps a line's own `or` binding to that line.
  const lines = topLevelLines(src)
  if (lines.length > 1) src = lines.map((l) => `(${l})`).join(" and ")
  const tokens = tokenize(src)
  let i = 0

  // Past the last token there is none: the type says so.
  const peek = (): Token | undefined => tokens[i]
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
    // "field is [not] empty" - the wordy form the builder writes.
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
    // "field [not] in (a, b)" and "field [not] matches value".
    const save = i
    let not = false
    if (isWord("not")) {
      not = true
      i++
    }
    if (isWord("in")) {
      i++
      return {
        kind: "cmp",
        field,
        cmp: not ? "not_in" : "in",
        values: list(),
      }
    }
    if (isWord("matches")) {
      i++
      return {
        kind: "cmp",
        field,
        cmp: not ? "not_matches" : "matches",
        value: value(),
      }
    }
    i = save
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

  function list(): string[] {
    const open = peek()
    if (open?.t !== "(")
      throw new ParseError('Expected "(" after in', open?.pos ?? src.length)
    i++
    const out: string[] = []
    if (peek()?.t === ")") {
      i++
      return out
    }
    for (;;) {
      out.push(value())
      const next = peek()
      if (next?.t === ",") {
        i++
        continue
      }
      if (next?.t === ")") {
        i++
        return out
      }
      throw new ParseError('Expected "," or ")"', next?.pos ?? src.length)
    }
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

// ─── Formatter (canonical text - what the builder writes) ───────────────

function quoteIfNeeded(v: string): string {
  return /^[A-Za-z0-9_.@+/:-]+$/.test(v) && v !== "" ? v : `"${v}"`
}

export function format(expr: Expr | null, parent?: "and" | "or"): string {
  if (!expr) return ""
  if (isListExpr(expr))
    return `${expr.field} ${expr.cmp === "in" ? "in" : "not in"} (${expr.values
      .map(quoteIfNeeded)
      .join(", ")})`
  if (expr.kind === "cmp") {
    const e = expr
    if (e.cmp === "matches" || e.cmp === "not_matches")
      return `${e.field} ${e.cmp === "matches" ? "matches" : "not matches"} ${quoteIfNeeded(e.value)}`
    return `${e.field} ${e.cmp} ${quoteIfNeeded(e.value)}`
  }
  if (expr.kind === "empty")
    return `${expr.field} is ${expr.negated ? "not " : ""}empty`
  const inner = expr.terms.map((t) => format(t, expr.op)).join(` ${expr.op} `)
  // Parenthesise an OR living inside an AND - the only precedence hazard.
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

function regexOf(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
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
  const present = values.filter(
    (v) => v !== null && v !== undefined && v !== ""
  )
  if (isListExpr(expr)) {
    const wanted = expr.values.map((w) => w.toLowerCase())
    const hit = present.some((v) => wanted.includes(String(v).toLowerCase()))
    return expr.cmp === "in" ? hit : !hit
  }
  const scalar = expr
  if (scalar.cmp === "matches" || scalar.cmp === "not_matches") {
    const re = regexOf(scalar.value)
    const hit = !!re && present.some((v) => re.test(String(v)))
    return scalar.cmp === "matches" ? hit : !hit
  }
  const cmp = scalar.cmp
  const wanted = scalar.value
  // Negative comparisons must hold for every element ("tags !~ core" means no
  // tag contains it); positive ones for any.
  if (cmp === "!=" || cmp === "!~") {
    if (values.length === 0) return true
    return values.every((v) => compare(v, cmp, wanted))
  }
  return values.some((v) => compare(v, cmp, wanted))
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A raw id (a foreign key's `manufacturer_id`), as opposed to a field that is
 * only named like one - a VLAN's `vlan_id`, a rack's `facility_id`. */
function isRawId(key: string, v: unknown): boolean {
  return key.endsWith("_id") && typeof v === "string" && UUID.test(v)
}

/** Derive the filterable field paths from the rows themselves (two levels
 * deep, name-bearing objects surfaced under their own key), so the builder
 * needs no per-model registry - like the facet rail, it describes exactly the
 * list it sits on. */
export function discoverFields(rows: unknown[]): FieldInfo[] {
  const found = new Map<
    string,
    { kind: FieldInfo["kind"]; samples: Set<string> }
  >()
  const note = (path: string, v: unknown) => {
    const scalar = scalarOf(v)
    if (scalar === null || scalar === undefined || scalar === "") return
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
      if (SKIP_KEYS.has(key) || isRawId(key, v)) continue
      if (v === null || v === undefined) continue
      if (Array.isArray(v)) {
        for (const el of v.slice(0, 5)) note(key, el)
      } else if (typeof v === "object") {
        note(key, v) // the object itself (name/slug)
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
          if (SKIP_KEYS.has(k2) || isRawId(k2, v2)) continue
          if (v2 === null || Array.isArray(v2)) continue
          // A scalar, or a named object one step out (a device's
          // site.region) - it filters by its name like a top-level one.
          note(`${key}.${k2}`, v2)
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
  cmp: BuilderOp
  value: string
  /** The values of an `in` / `not in` rule. */
  values?: string[]
}

function ruleOfExpr(e: Expr): BuilderRule | null {
  if (e.kind === "empty")
    return { field: e.field, cmp: e.negated ? "not_empty" : "empty", value: "" }
  if (e.kind !== "cmp") return null
  if (isListExpr(e))
    return { field: e.field, cmp: e.cmp, value: "", values: [...e.values] }
  const scalar = e
  return { field: scalar.field, cmp: scalar.cmp, value: scalar.value }
}

function exprOfRule(r: BuilderRule): Expr {
  if (r.cmp === "empty" || r.cmp === "not_empty")
    return { kind: "empty", field: r.field, negated: r.cmp === "not_empty" }
  if (r.cmp === "in" || r.cmp === "not_in")
    return { kind: "cmp", field: r.field, cmp: r.cmp, values: r.values ?? [] }
  return { kind: "cmp", field: r.field, cmp: r.cmp, value: r.value }
}

/** A flat (single-combinator) view of the AST, or null when the expression
 * uses nesting the builder can't show - the text editor still can. */
export function toBuilder(
  expr: Expr | null
): { op: "and" | "or"; rules: BuilderRule[] } | null {
  const ruleOf = ruleOfExpr
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
  const terms: Expr[] = rules.filter((r) => r.field).map(exprOfRule)
  if (terms.length === 0) return null
  return terms.length === 1 ? terms[0] : { kind: "group", op, terms }
}

/** Group view of an expression: OR-separated groups of AND-ed rules - the
 * shape "a or (b and c)" that the flat builder couldn't show. Null only for
 * genuinely deeper nesting (an `or` inside an `and` inside an `or`, …). */
export function toGroups(expr: Expr | null): BuilderRule[][] | null {
  const ruleOf = ruleOfExpr
  const groupOf = (e: Expr): BuilderRule[] | null => {
    const single = ruleOf(e)
    if (single) return [single]
    if (e.kind !== "group" || e.op !== "and") return null
    const rules: BuilderRule[] = []
    for (const t of e.terms) {
      const r = ruleOf(t)
      if (!r) return null
      rules.push(r)
    }
    return rules
  }
  if (!expr) return [[]]
  const single = groupOf(expr)
  if (single) return [single]
  if (expr.kind !== "group" || expr.op !== "or") return null
  const groups: BuilderRule[][] = []
  for (const t of expr.terms) {
    const g = groupOf(t)
    if (!g) return null
    groups.push(g)
  }
  return groups
}

/** The inverse of `toGroups` - incomplete rules (no field) are dropped. */
export function fromGroups(groups: BuilderRule[][]): Expr | null {
  const terms: Expr[] = []
  for (const g of groups) {
    const e = fromBuilder("and", g)
    if (e) terms.push(e)
  }
  if (terms.length === 0) return null
  return terms.length === 1 ? terms[0] : { kind: "group", op: "or", terms }
}

// ─── Tree view of an AST (the nested builder) ───────────────────────────

export interface TreeRule extends BuilderRule {
  kind: "rule"
  id: number
}
export interface TreeGroup {
  kind: "group"
  id: number
  op: "and" | "or"
  items: TreeNode[]
}
export type TreeNode = TreeRule | TreeGroup

let lastId = 0
/** A fresh id for a builder row or group (stable while it is edited). */
export const treeId = () => ++lastId

export const blankRule = (): TreeRule => ({
  kind: "rule",
  id: treeId(),
  field: "",
  cmp: "=",
  value: "",
})

export const blankGroup = (
  op: "and" | "or" = "and",
  items: TreeNode[] = [blankRule()]
): TreeGroup => ({ kind: "group", id: treeId(), op, items })

/** The builder's tree for an expression: groups at most `maxGroups` deep
 * (the root counts), or null when it nests deeper - the text editor still
 * shows it. A single condition sits in an "and" root. */
export function toTree(expr: Expr | null, maxGroups = 3): TreeGroup | null {
  const node = (e: Expr, level: number): TreeNode | null => {
    if (e.kind !== "group") {
      const r = ruleOfExpr(e)
      return r ? { kind: "rule", id: treeId(), ...r } : null
    }
    if (level > maxGroups) return null
    const items: TreeNode[] = []
    for (const t of e.terms) {
      const n = node(t, level + 1)
      if (!n) return null
      items.push(n)
    }
    return { kind: "group", id: treeId(), op: e.op, items }
  }
  if (!expr) return { kind: "group", id: treeId(), op: "and", items: [] }
  if (expr.kind !== "group") {
    const r = node(expr, 1)
    return r ? { kind: "group", id: treeId(), op: "and", items: [r] } : null
  }
  const root = node(expr, 1)
  return root && root.kind === "group" ? root : null
}

/** How many groups deep the tree goes, the root included. */
export function treeDepth(group: TreeGroup): number {
  let deepest = 0
  for (const it of group.items)
    if (it.kind === "group") deepest = Math.max(deepest, treeDepth(it))
  return 1 + deepest
}

/** The expression a tree describes, plus which builder row or group each
 * node of it came from, by its dotted path (`terms.1.terms.0`) - so an error
 * the server reports against a path lands on the right row. Rows without a
 * field and groups left empty are dropped; a group of one is its one term. */
export function fromTreeWithPaths(group: TreeGroup): {
  expr: Expr | null
  paths: Map<string, number>
} {
  const origin = new WeakMap<object, number>()
  const build = (n: TreeNode): Expr | null => {
    if (n.kind === "rule") {
      if (!n.field) return null
      const e = exprOfRule(n)
      origin.set(e, n.id)
      return e
    }
    const terms = n.items.map(build).filter((t): t is Expr => t !== null)
    if (terms.length === 0) return null
    if (terms.length === 1) return terms[0]
    const e: Expr = { kind: "group", op: n.op, terms }
    origin.set(e, n.id)
    return e
  }
  const expr = build(group)
  const paths = new Map<string, number>()
  const walk = (e: Expr, path: string) => {
    const id = origin.get(e)
    if (id !== undefined) paths.set(path, id)
    if (e.kind === "group")
      e.terms.forEach((t, i) =>
        walk(t, path ? `${path}.terms.${i}` : `terms.${i}`)
      )
  }
  if (expr) walk(expr, "")
  return { expr, paths }
}

export function fromTree(group: TreeGroup): Expr | null {
  return fromTreeWithPaths(group).expr
}

/** The builder row or group an error path points at: the longest known
 * prefix of it (`terms.1.values.0` → the row at `terms.1`). */
export function nodeForPath(
  paths: Map<string, number>,
  path: string
): number | undefined {
  const parts = path ? path.split(".") : []
  for (let n = parts.length; n >= 0; n--) {
    const id = paths.get(parts.slice(0, n).join("."))
    if (id !== undefined) return id
  }
  return undefined
}
