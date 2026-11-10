import type { VulnUpdateSource, VulnVersionScheme } from "@/lib/api"

// Suggest mappings (#451): the rows of
// GET /api/vulnerabilities/mappings/suggestions/ and the body of
// POST /api/vulnerabilities/mappings/bulk-create/, plus the pure helpers the
// dialog uses (what starts ticked, what is sent, what the toast says).

export type SuggestionSubject = "platform" | "application" | "device_type"
export type SuggestionSource = "sbom" | "known" | "local" | "nvd"
export type SuggestionConfidence = "high" | "medium" | "low"

export interface SuggestionCandidate {
  kind: "cpe" | "purl"
  part: "" | "o" | "a" | "h"
  vendor: string
  product: string
  identifier: string
  source: SuggestionSource
  confidence: SuggestionConfidence
  title: string
  version_scheme: VulnVersionScheme
  /** `auto` resolved for this product. */
  scheme: VulnVersionScheme
  /** `local`: records in the store naming it. */
  records?: number
}

export interface MappingSuggestion {
  subject_type: SuggestionSubject
  id: string
  name: string
  manufacturer: string
  purl_template: string
  cpe_template: string
  /** Hosts (platform), installs (application) or devices (device type). */
  in_use: number
  /** Of those, with a blank version: they cannot match. */
  without_version: number
  candidates: SuggestionCandidate[]
}

export type NvdStatus = "off" | "not_asked" | "ok" | "limited" | "error"

export interface SuggestionsPage {
  count: number
  results: MappingSuggestion[]
  totals: {
    subjects: number
    in_use: number
    without_version: number
    with_candidate: number
  }
  update_source: VulnUpdateSource
  nvd_status: NvdStatus
  nvd_pending: number
  retry_after?: number
}

export interface BulkCreateRow {
  platform?: string
  application?: string
  device_type?: string
  identifier: string
  version_scheme?: VulnVersionScheme
}

export interface BulkCreateResult {
  created: { id: string; identifier: string }[]
  update_source: VulnUpdateSource
}

export const SUBJECT_LABELS: Record<SuggestionSubject, string> = {
  platform: "Platform",
  application: "Application",
  device_type: "Device type",
}

export const SOURCE_LABELS: Record<SuggestionSource, string> = {
  sbom: "SBOM",
  known: "Known",
  local: "In store",
  nvd: "NVD",
}

export const CONFIDENCE_LABELS: Record<SuggestionConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
}

export function bestConfidence(
  row: MappingSuggestion
): SuggestionConfidence | "none" {
  return row.candidates[0]?.confidence ?? "none"
}

/** Rows ticked when the list opens: only a high-confidence best candidate. */
export function preselect(rows: MappingSuggestion[]): Set<string> {
  return new Set(
    rows.filter((r) => bestConfidence(r) === "high").map((r) => r.id)
  )
}

/** The candidate a row maps to: the one picked, else the best. */
export function chosenCandidate(
  row: MappingSuggestion,
  picked: Record<string, string>
): SuggestionCandidate | undefined {
  const id = picked[row.id]
  return row.candidates.find((c) => c.identifier === id) ?? row.candidates[0]
}

/** The bulk-create body: the ticked rows that have a product, in order. */
export function bulkPayload(
  rows: MappingSuggestion[],
  selected: Set<string>,
  picked: Record<string, string>,
  schemes: Record<string, VulnVersionScheme>
): { body: BulkCreateRow[]; ids: string[] } {
  const body: BulkCreateRow[] = []
  const ids: string[] = []
  for (const row of rows) {
    if (!selected.has(row.id)) continue
    const c = chosenCandidate(row, picked)
    if (!c) continue
    const item: BulkCreateRow = {
      [row.subject_type]: row.id,
      identifier: c.identifier,
    }
    const scheme = schemes[row.id] as VulnVersionScheme | undefined
    if (row.subject_type !== "device_type" && scheme && scheme !== "auto")
      item.version_scheme = scheme
    body.push(item)
    ids.push(row.id)
  }
  return { body, ids }
}

/** A 400/403's per-row errors (keyed by index) moved onto the subject ids. */
export function rowErrors(
  errors: unknown,
  ids: string[]
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!errors || typeof errors !== "object") return out
  for (const [i, v] of Object.entries(errors as Record<string, unknown>)) {
    const id = ids[Number(i)]
    if (!id) continue
    const msgs =
      v && typeof v === "object"
        ? Object.values(v as Record<string, unknown>).flat()
        : [v]
    out[id] = msgs.map(String).join(" ")
  }
  return out
}

/** Hosts, installs or devices the ticked rows cover; how many lack a version. */
export function coverage(rows: MappingSuggestion[], selected: Set<string>) {
  let covered = 0
  let blank = 0
  for (const r of rows) {
    if (!selected.has(r.id) || !r.candidates.length) continue
    covered += r.in_use
    blank += r.without_version
  }
  return { covered, blank }
}

/** What happens next, per update source, under the "Created" toast. */
export function nextStep(
  source: VulnUpdateSource,
  identifiers: string[]
): string {
  if (source === "server") return "Fetching their records now."
  if (source === "browser") return "Sync now to fetch their records."
  const shown = identifiers.slice(0, 3).join(", ")
  const more = identifiers.length > 3 ? ` +${identifiers.length - 3}` : ""
  return `Import NVD or OSV records for ${shown}${more}.`
}
