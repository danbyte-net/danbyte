import { Square, icons } from "lucide-react"

import { cn } from "@/lib/utils"

// Lucide exports its full icon map keyed by PascalCase component name.
// User-facing icon names (FloorTileType.icon, IPRole.icon) are the kebab-case
// spelling Lucide documents ("door-closed", "grid-3x3"), so build a
// kebab → component index once at module load.
type LucideComponent = (typeof icons)[keyof typeof icons]

function pascalToKebab(name: string): string {
  return name
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])(\d)/g, "$1-$2")
    .toLowerCase()
}

const byKebab = new Map<string, LucideComponent>()
for (const [pascal, component] of Object.entries(icons)) {
  byKebab.set(pascalToKebab(pascal), component)
}

/** All valid icon names (kebab-case), sorted — the icon picker's corpus. */
export const ICON_NAMES: string[] = [...byKebab.keys()].sort()

export function isValidIconName(name: string): boolean {
  return byKebab.has(name)
}

/** The raw Lucide component for a kebab-case name, or null. The floor-plan
 * canvas uses this to draw icons as nested `<svg>` children with explicit
 * x/y/width/height instead of CSS-sized elements. */
export function getLucideIcon(name: string): LucideComponent | null {
  return byKebab.get(name) ?? null
}

/**
 * Render a Lucide icon by its kebab-case name. Unknown / removed names fall
 * back to a neutral square so stale palette entries never crash the canvas.
 */
export function DynamicIcon({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  const Icon = byKebab.get(name) ?? Square
  return <Icon className={cn("h-4 w-4", className)} />
}
