import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { cardAnchor } from "@/components/settings/settings-card"
import {
  SETTINGS_CARDS,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
} from "./settings-catalog"

// Where a page's cards are actually rendered. Most live in the route file;
// a few were lifted into components so a merged page's route stays thin.
const EXTRA_SOURCES: Record<string, string[]> = {
  monitoring: ["src/components/settings/monitoring-deployment.tsx"],
  separation: ["src/components/settings/separation-deployment.tsx"],
  security: ["src/components/settings/chat-model-card.tsx"],
  directory: ["src/components/settings/ldap-directory.tsx"],
}

function sourcesFor(pageKey: string): string {
  const page = SETTINGS_PAGES.find((p) => p.key === pageKey)
  if (!page) throw new Error(`no page ${pageKey}`)
  const route = page.to.replace(/^\/settings\/?/, "") || "index"
  const paths = [
    `src/routes/settings.${route}.tsx`,
    ...(EXTRA_SOURCES[pageKey] ?? []),
  ]
  return paths
    .map((p) => {
      try {
        return readFileSync(join(process.cwd(), p), "utf8")
      } catch {
        return ""
      }
    })
    .join("\n")
}

describe("settings catalog", () => {
  it("gives every page a group that exists", () => {
    const keys = new Set(SETTINGS_GROUPS.map((g) => g.key))
    for (const page of SETTINGS_PAGES) {
      expect(keys, `${page.key} group`).toContain(page.group)
    }
  })

  it("keys pages and cards uniquely", () => {
    const pageKeys = SETTINGS_PAGES.map((p) => p.key)
    expect(new Set(pageKeys).size).toBe(pageKeys.length)
    const cardKeys = SETTINGS_CARDS.map((c) => c.key)
    expect(new Set(cardKeys).size).toBe(cardKeys.length)
  })

  it("points every card at a page in the catalog", () => {
    const keys = new Set(SETTINGS_PAGES.map((p) => p.key))
    for (const card of SETTINGS_CARDS) {
      expect(keys, `${card.key} page`).toContain(card.page)
    }
  })

  it("keeps card anchors unique within a page", () => {
    const seen = new Map<string, string>()
    for (const card of SETTINGS_CARDS) {
      const id = `${card.page}#${cardAnchor(card.label)}`
      expect(seen.get(id), `${card.key} collides with ${seen.get(id)}`).toBe(
        undefined
      )
      seen.set(id, card.key)
    }
  })

  // The one that earns its keep: renaming a card in the JSX without updating
  // the catalog would leave a search result linking to an anchor that no
  // longer exists, and nothing else would notice.
  it("still finds every card's title in the page that renders it", () => {
    const missing: string[] = []
    for (const card of SETTINGS_CARDS) {
      const source = sourcesFor(card.page)
      if (!source.includes(`title="${card.label}"`)) {
        missing.push(`${card.key} → title="${card.label}"`)
      }
    }
    expect(missing).toEqual([])
  })
})
