// A deploy pipeline "as code": the API speaks JSON (GET .../export/, POST
// .../import/); this file turns that into the small YAML the editor shows and
// reads the same subset back for import. It is deliberately not a YAML
// library: it writes and reads exactly the shape below - scalars, one inline
// list of strings, and a list of flat step maps.
//
//   name: Router
//   object_types: [device]
//   auto_on_change: false
//   steps:
//     - target: Plan VNets
//       stop_on_failure: true
//     - target: Push config
//       wait_for_result: true
import type { DeployPipelineCode } from "@/lib/api"

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9 _./()@+-]*$/
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?)$/i

/** A scalar as YAML: plain when that reads back as the same string,
 * double-quoted (JSON escaping, which YAML accepts) otherwise. */
export function yamlScalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v)
  if (v !== "" && PLAIN.test(v) && !RESERVED.test(v) && v.trim() === v) {
    return v
  }
  return JSON.stringify(v)
}

function inlineList(items: string[]): string {
  return `[${items.map(yamlScalar).join(", ")}]`
}

/** The pipeline as YAML. Step keys at their default are left out, the way
 * the editor's preview shows them; `full` writes every key. */
export function pipelineToYaml(
  p: DeployPipelineCode,
  { full = false }: { full?: boolean } = {}
): string {
  const out: string[] = [`name: ${yamlScalar(p.name)}`]
  if (p.description) out.push(`description: ${yamlScalar(p.description)}`)
  out.push(`object_types: ${inlineList(p.object_types ?? ["device"])}`)
  out.push(`auto_on_change: ${p.auto_on_change ? "true" : "false"}`)
  if (full || p.enabled === false)
    out.push(`enabled: ${p.enabled === false ? "false" : "true"}`)
  if (p.roles && p.roles.length) out.push(`roles: ${inlineList(p.roles)}`)
  out.push("steps:")
  for (const s of p.steps) {
    out.push(`  - target: ${yamlScalar(s.target)}`)
    const stop = s.stop_on_failure ?? true
    if (full || !stop) out.push(`    stop_on_failure: ${stop}`)
    if (full || s.wait_for_result)
      out.push(`    wait_for_result: ${!!s.wait_for_result}`)
    const timeout = s.timeout_minutes ?? 30
    if (full || timeout !== 30) out.push(`    timeout_minutes: ${timeout}`)
  }
  return out.join("\n") + "\n"
}

export class PipelineCodeError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(`Line ${line}: ${message}`)
    this.line = line
  }
}

function parseScalar(raw: string, line: number): string | number | boolean {
  const v = raw.trim()
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      throw new PipelineCodeError("Unclosed or bad quoted string.", line)
    }
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2)
      throw new PipelineCodeError("Unclosed quoted string.", line)
    return v.slice(1, -1).replace(/''/g, "'")
  }
  if (/^(true|yes|on)$/i.test(v)) return true
  if (/^(false|no|off)$/i.test(v)) return false
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}

function stripComment(text: string): string {
  // A # starts a comment outside quotes when it opens the line or follows a
  // space.
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === "\\" && quote === '"') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1])))
      return text.slice(0, i)
  }
  return text
}

function parseList(raw: string, line: number): string[] {
  const v = raw.trim()
  if (!v.startsWith("[") || !v.endsWith("]"))
    throw new PipelineCodeError("Expected a list like [device].", line)
  const body = v.slice(1, -1).trim()
  if (!body) return []
  const items: string[] = []
  let cur = ""
  let quote: string | null = null
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      cur += c
      if (c === "\\" && quote === '"') cur += body[++i] ?? ""
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === ",") {
      items.push(String(parseScalar(cur, line)))
      cur = ""
    } else cur += c
  }
  items.push(String(parseScalar(cur, line)))
  return items
}

const TOP_KEYS = new Set([
  "name",
  "description",
  "object_types",
  "auto_on_change",
  "enabled",
  "roles",
  "steps",
])
const STEP_KEYS = new Set([
  "target",
  "stop_on_failure",
  "wait_for_result",
  "timeout_minutes",
])

/** Read the YAML subset {@link pipelineToYaml} writes. Throws
 * {@link PipelineCodeError} naming the line. JSON is accepted too. */
export function parsePipelineYaml(text: string): DeployPipelineCode {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as DeployPipelineCode
    } catch {
      throw new PipelineCodeError("Not valid JSON.", 1)
    }
  }
  const out: Record<string, unknown> = {}
  const steps: Record<string, unknown>[] = []
  let inSteps = false
  let step: Record<string, unknown> | null = null
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  lines.forEach((rawLine, idx) => {
    const n = idx + 1
    const line = stripComment(rawLine).replace(/\s+$/, "")
    if (!line.trim() || line.trim() === "---") return
    const indent = line.length - line.trimStart().length
    let body = line.trim()
    if (indent === 0) {
      inSteps = false
      step = null
      const m = /^([a-z_]+):\s*(.*)$/.exec(body)
      if (!m) throw new PipelineCodeError("Expected key: value.", n)
      const [, key, value] = m
      if (!TOP_KEYS.has(key))
        throw new PipelineCodeError(`Unknown key ${key}.`, n)
      if (key === "steps") {
        if (value.trim())
          throw new PipelineCodeError("List the steps below.", n)
        inSteps = true
        return
      }
      out[key] =
        key === "object_types" || key === "roles"
          ? parseList(value, n)
          : parseScalar(value, n)
      return
    }
    if (!inSteps) throw new PipelineCodeError("Unexpected indent.", n)
    if (body.startsWith("- ") || body === "-") {
      step = {}
      steps.push(step)
      body = body.slice(1).trim()
      if (!body) return
    }
    if (!step) throw new PipelineCodeError("A step starts with -.", n)
    const m = /^([a-z_]+):\s*(.*)$/.exec(body)
    if (!m) throw new PipelineCodeError("Expected key: value.", n)
    const [, key, value] = m
    if (!STEP_KEYS.has(key))
      throw new PipelineCodeError(`Unknown step key ${key}.`, n)
    step[key] = parseScalar(value, n)
  })
  if (typeof out.name === "number") out.name = String(out.name)
  if (typeof out.name !== "string" || !out.name)
    throw new PipelineCodeError("A name is required.", 1)
  for (const [i, s] of steps.entries()) {
    if (typeof s.target === "number") s.target = String(s.target)
    if (typeof s.target !== "string" || !s.target)
      throw new PipelineCodeError(`Step ${i + 1} names no target.`, 1)
  }
  return {
    ...(out as Omit<DeployPipelineCode, "steps">),
    steps,
  } as DeployPipelineCode
}
