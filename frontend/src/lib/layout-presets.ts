import { api } from "@/lib/api"

// Layout presets - named sets of table layouts a deployment admin shares as
// the default for users, groups or the whole tenant (/api/prefs/presets/).
// People receive them through /api/prefs/columns/<table>/; only the
// Settings → Table layouts page manages them.

export const PRESETS_ENDPOINT = "/api/prefs/presets/"
export const PRESETS_KEY = ["layout-presets"] as const

export interface PresetTableCounts {
  shown: number
  hidden: number
  pinned: number
}

export interface LayoutPreset {
  id: string
  name: string
  description: string
  everyone: boolean
  weight: number
  users: { id: number; username: string; display_name: string }[]
  groups: { id: number; name: string }[]
  /** Table id → what the preset's layout for it shows. */
  tables: Record<string, PresetTableCounts>
  updated_at: string | null
  created_by: string | null
}

export interface PresetWrite {
  name?: string
  description?: string
  everyone?: boolean
  weight?: number
  user_ids?: number[]
  group_ids?: number[]
  /** Copy your own layouts in: every table, or the ones named. */
  capture?: "all" | string[]
  remove_tables?: string[]
}

export interface ResetCounts {
  dry_run: boolean
  users: number
  tables: number
  layouts: number
}

export function listPresets() {
  return api<{ results: LayoutPreset[] }>(PRESETS_ENDPOINT).then(
    (r) => r.results
  )
}

export function savePreset(id: string | null, body: PresetWrite) {
  return api<LayoutPreset>(
    id ? `${PRESETS_ENDPOINT}${id}/` : PRESETS_ENDPOINT,
    {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(body),
    }
  )
}

export function deletePreset(id: string) {
  return api(`${PRESETS_ENDPOINT}${id}/`, { method: "DELETE" })
}

export function resetPersonalLayouts(id: string, dryRun: boolean) {
  return api<ResetCounts>(`${PRESETS_ENDPOINT}${id}/reset/`, {
    method: "POST",
    body: JSON.stringify({ dry_run: dryRun }),
  })
}

/** Who a preset reaches, in a few words: "Everyone", "2 groups · 1 user". */
export function assigneeSummary(
  p: Pick<LayoutPreset, "everyone" | "users" | "groups">
) {
  if (p.everyone) return "Everyone"
  const parts = []
  if (p.groups.length)
    parts.push(
      `${p.groups.length} ${p.groups.length === 1 ? "group" : "groups"}`
    )
  if (p.users.length)
    parts.push(`${p.users.length} ${p.users.length === 1 ? "user" : "users"}`)
  return parts.join(" · ") || "Nobody"
}
