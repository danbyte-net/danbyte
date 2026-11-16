import type {
  VulnAnalysisJustification,
  VulnAnalysisResponse,
  VulnAnalysisState,
  VulnException,
  VulnExceptionScope,
  VulnExceptionStatus,
  VulnExceptionWrite,
  VulnMatch,
} from "@/lib/api"

// The rules of a vulnerability exception (#451), as the API checks them
// (vulnerabilities/exceptions_api.py), so the dialog says what is wrong
// before it is sent. The server stays the judge: its field errors land on
// the same fields.

export const MAX_RISK_DAYS = 365
/** An exception within this many days of its expiry reads as expiring. */
export const EXPIRING_DAYS = 30

export const STATUS_LABELS: Record<VulnExceptionStatus, string> = {
  not_applicable: "Not applicable",
  risk_accepted: "Risk accepted",
}

export const SCOPE_LABELS: Record<VulnExceptionScope, string> = {
  device: "Device",
  virtual_machine: "Virtual machine",
  platform: "Platform",
  application: "Application",
  tenant: "Tenant",
}

/** The analysis states each status may carry; the first is the default. */
export const STATUS_STATES: Record<VulnExceptionStatus, VulnAnalysisState[]> = {
  not_applicable: ["not_affected", "false_positive"],
  risk_accepted: ["exploitable"],
}

export const STATE_LABELS: Record<VulnAnalysisState, string> = {
  not_affected: "Not affected",
  false_positive: "False positive",
  exploitable: "Exploitable",
}

export const JUSTIFICATION_LABELS: Record<
  Exclude<VulnAnalysisJustification, "">,
  string
> = {
  code_not_present: "Code not present",
  code_not_reachable: "Code not reachable",
  requires_configuration: "Requires configuration",
  requires_dependency: "Requires dependency",
  requires_environment: "Requires environment",
  protected_by_compiler: "Protected by compiler",
  protected_at_runtime: "Protected at runtime",
  protected_at_perimeter: "Protected at perimeter",
  protected_by_mitigating_control: "Protected by mitigating control",
}

export const RESPONSE_LABELS: Record<VulnAnalysisResponse, string> = {
  can_not_fix: "Can not fix",
  will_not_fix: "Will not fix",
  update: "Update",
  rollback: "Rollback",
  workaround_available: "Workaround available",
}

/** `iso` plus `days`, as an ISO day. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/** Whole days from `today` to `iso` (negative once past). */
export function daysUntil(iso: string, today: string): number {
  const a = Date.parse(`${today}T00:00:00Z`)
  const b = Date.parse(`${iso}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/** The latest expiry a status allows; none for not applicable. */
export function maxExpiry(
  status: VulnExceptionStatus,
  today: string
): string | undefined {
  return status === "risk_accepted" ? addDays(today, MAX_RISK_DAYS) : undefined
}

/** What is wrong with an expiry date, or null. */
export function expiryError(
  status: VulnExceptionStatus,
  expires: string,
  today: string
): string | null {
  if (!expires)
    return status === "risk_accepted"
      ? "A risk acceptance needs an expiry date."
      : null
  if (expires < today) return "Not in the past."
  const latest = maxExpiry(status, today)
  if (latest && expires > latest) return `At most ${MAX_RISK_DAYS} days ahead.`
  return null
}

export type ExpiryState = "expired" | "expiring" | "ok" | "none"

/** Expired, within EXPIRING_DAYS of it, later, or open-ended. */
export function expiryState(
  expires: string | null,
  today: string
): ExpiryState {
  if (!expires) return "none"
  const n = daysUntil(expires, today)
  if (n < 0) return "expired"
  if (n <= EXPIRING_DAYS) return "expiring"
  return "ok"
}

export interface Analysis {
  state: VulnAnalysisState
  justification: VulnAnalysisJustification
  response: VulnAnalysisResponse[]
}

/** The CycloneDX analysis a status starts with. */
export function defaultAnalysis(status: VulnExceptionStatus): Analysis {
  return status === "risk_accepted"
    ? { state: "exploitable", justification: "", response: ["will_not_fix"] }
    : { state: "not_affected", justification: "", response: [] }
}

/** The analysis kept valid for a new status: a state the status cannot
 * carry falls back to its default, a justification needs not_affected. */
export function analysisFor(
  status: VulnExceptionStatus,
  a: Analysis
): Analysis {
  const allowed = STATUS_STATES[status]
  if (!allowed.includes(a.state)) return defaultAnalysis(status)
  return {
    ...a,
    justification: a.state === "not_affected" ? a.justification : "",
  }
}

/** Which kind of scope a dialog offers: the match's host, its platform or
 * application (whichever the match came through), or the whole tenant. */
export type ScopeChoice = "host" | "subject" | "tenant"

/** The scope and subject one match gets for a choice; null when the match
 * cannot take it (a platform match through a device type mapping). */
export function subjectOf(
  m: VulnMatch,
  choice: ScopeChoice
): { scope: VulnExceptionScope; id: string | null } | null {
  if (choice === "tenant") return { scope: "tenant", id: null }
  if (choice === "host") {
    if (m.device) return { scope: "device", id: m.device.id }
    if (m.virtual_machine)
      return { scope: "virtual_machine", id: m.virtual_machine.id }
    return null
  }
  if (m.via === "application") {
    const app = m.installed_software?.application
    return app ? { scope: "application", id: app.id } : null
  }
  // A package or OS-build match has no catalog subject: host or tenant only.
  const p = m.mapping?.platform
  return p ? { scope: "platform", id: p.id } : null
}

export interface ScopeOption {
  value: ScopeChoice
  label: string
  /** How many of the matches it covers (those that can take it). */
  covers: number
}

/** The scope choices for these matches, given the scopes the caller may
 * create (GET …/scopes/). A choice is offered when at least one match can
 * take it with an allowed scope. `kind` names the page it opens from. */
export function scopeOptions(
  matches: VulnMatch[],
  allowed: readonly VulnExceptionScope[],
  kind?: "device" | "virtual_machine" | "platform" | "application" | "record"
): ScopeOption[] {
  const can = new Set(allowed)
  const covers = (choice: ScopeChoice) =>
    matches.filter((m) => {
      const s = subjectOf(m, choice)
      return s !== null && can.has(s.scope)
    }).length
  const labels: Record<ScopeChoice, string> = {
    host:
      kind === "device"
        ? "This device"
        : kind === "virtual_machine"
          ? "This VM"
          : "Its device or VM",
    subject:
      kind === "platform"
        ? "This platform"
        : kind === "application"
          ? "This application"
          : "Its platform or application",
    tenant: "Whole tenant",
  }
  return (["host", "subject", "tenant"] as ScopeChoice[])
    .map((value) => ({ value, label: labels[value], covers: covers(value) }))
    .filter((o) => o.covers > 0)
}

/** The scope a dialog opens on: the page's own subject on a platform or
 * application page, else the host; the first offered when that is not. */
export function defaultScope(
  options: ScopeOption[],
  kind?: string
): ScopeChoice | null {
  const want: ScopeChoice =
    kind === "platform" || kind === "application" ? "subject" : "host"
  return (
    options.find((o) => o.value === want)?.value ?? options[0]?.value ?? null
  )
}

export interface ExceptionDraft {
  status: VulnExceptionStatus
  reason: string
  owner: number | null
  expires: string
  analysis: Analysis
}

/** One POST body per distinct record and subject the matches give. */
export function createBodies(
  matches: VulnMatch[],
  choice: ScopeChoice,
  d: ExceptionDraft
): VulnExceptionWrite[] {
  const out = new Map<string, VulnExceptionWrite>()
  for (const m of matches) {
    const s = subjectOf(m, choice)
    if (!s) continue
    const key = `${m.cve.vuln_id}|${s.scope}|${s.id ?? ""}`
    if (out.has(key)) continue
    out.set(key, {
      vuln_id: m.cve.vuln_id,
      status: d.status,
      reason: d.reason.trim(),
      owner_id: d.owner,
      expires_on: d.expires || null,
      ...(s.scope !== "tenant" && s.id ? { [`${s.scope}_id`]: s.id } : {}),
      analysis_state: d.analysis.state,
      analysis_justification: d.analysis.justification,
      analysis_response: d.analysis.response,
    })
  }
  return [...out.values()]
}

/** The PATCH for an edit: the changed fields only. Record and scope do not
 * change. */
export function editPatch(
  ex: VulnException,
  d: ExceptionDraft
): VulnExceptionWrite {
  const out: VulnExceptionWrite = {}
  if (d.status !== ex.status) out.status = d.status
  if (d.reason.trim() !== ex.reason) out.reason = d.reason.trim()
  if (d.owner !== (ex.owner?.id ?? null)) out.owner_id = d.owner
  if ((d.expires || null) !== ex.expires_on) out.expires_on = d.expires || null
  if (d.analysis.state !== ex.analysis_state)
    out.analysis_state = d.analysis.state
  if (d.analysis.justification !== ex.analysis_justification)
    out.analysis_justification = d.analysis.justification
  if (
    [...d.analysis.response].sort().join(",") !==
    [...ex.analysis_response].sort().join(",")
  )
    out.analysis_response = d.analysis.response
  return out
}

/** The exception's subject as one line: its name, or "Whole tenant". */
export function subjectName(ex: VulnException): string {
  const s = ex.device ?? ex.virtual_machine ?? ex.platform ?? ex.application
  return s?.name ?? "Whole tenant"
}
