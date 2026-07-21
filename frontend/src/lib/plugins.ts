import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

// ─── Server-driven plugin UI (mirrors plugins/ui_registry.py) ───────────────

export interface PluginNavItem {
  plugin: string
  title: string
  url: string
  icon: string
  section: string
  object_type: string | null
  perm: string | null
}

export interface PluginColumn {
  key: string
  label: string
  kind: string // text | mono | badge | tags | time
}

export interface PluginPage {
  plugin: string
  path: string
  kind: "list" | "detail"
  title: string
  endpoint: string
  object_type: string | null
  columns: PluginColumn[]
  detail_route: string | null
  title_field: string
  fields: PluginColumn[]
  tabs: string[]
  audited: boolean
  audit_type: string | null
}

export interface PluginPanel {
  plugin: string
  title: string
  endpoint: string
  kind: string
}

export interface PluginUi {
  nav: PluginNavItem[]
  pages: PluginPage[]
  panels: PluginPanel[]
}

export function usePluginUi() {
  return useQuery({
    queryKey: ["plugin-ui"],
    queryFn: () => api<PluginUi>("/api/plugins/ui/"),
    staleTime: 10 * 60_000,
  })
}

/** Resolve a page spec for a `/p/<slug>/<splat>` URL. Detail specs use a
 * "$id"-terminated path; a concrete id path matches the detail spec. */
export function resolvePluginPage(
  pages: PluginPage[],
  slug: string,
  splat: string
): { page: PluginPage; id?: string } | null {
  const parts = splat
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
  for (const page of pages) {
    if (page.plugin !== slug) continue
    const specParts = page.path.split("/").filter(Boolean)
    if (specParts.length !== parts.length) continue
    let id: string | undefined
    let ok = true
    for (let i = 0; i < specParts.length; i++) {
      if (specParts[i].startsWith("$")) id = parts[i]
      else if (specParts[i] !== parts[i]) {
        ok = false
        break
      }
    }
    if (ok) return { page, id }
  }
  return null
}

// ─── Plugin management (admin) — mirrors /api/plugins/ ──────────────────────

export interface PluginInfo {
  module: string
  slug: string
  name: string
  version: string
  author: string
  description: string
  state: "loaded" | "incompatible" | "error" | "pending"
  error: string
  min_version: string | null
  max_version: string | null
  unapplied_migrations: string[]
  /** Installed via offline upload (vs a pip-installed PLUGINS entry). */
  uploaded: boolean
}

export interface PluginList {
  plugins: PluginInfo[]
  has_pending_migrations: boolean
  /** An uploaded plugin is on disk but not loaded yet — restart needed. */
  pending_restart: boolean
  /** Whether to show the "Apply changes" prompt (migrations or pending load). */
  needs_apply: boolean
}

export function usePlugins() {
  return useQuery({
    queryKey: ["plugins-list"],
    queryFn: () => api<PluginList>("/api/plugins/"),
  })
}

export interface PluginConfigState {
  slug: string
  enabled: boolean
  tenant_enabled: boolean | null
  deployment_enabled: boolean | null
  default_enabled: boolean
}

// ─── Service control — mirrors /api/services/ ───────────────────────────────

export interface ServiceInfo {
  key: string
  unit: string
  label: string
  core: boolean
  state: string // active | inactive | failed | unknown
}

export function useServices(enabled = true) {
  return useQuery({
    queryKey: ["services"],
    queryFn: () => api<{ services: ServiceInfo[] }>("/api/services/"),
    enabled,
  })
}
