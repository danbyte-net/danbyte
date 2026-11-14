import { ColorBadge } from "@/components/cells/color-badge"
import { NamedIcon } from "@/components/dynamic-icon"
import type { DependencyLineStyle } from "@/lib/api"

/** A dependency medium as its pill: its colour, icon and name - the same
 * badge in the catalog, the dependency tables, the device tab and the
 * add dialog's options (#450). */
export function DependencyMediumBadge({
  medium,
  className,
}: {
  medium: { name: string; color?: string | null; icon?: string | null }
  className?: string
}) {
  return (
    <ColorBadge
      name={medium.name}
      color={medium.color || undefined}
      icon={
        medium.icon ? (
          <NamedIcon name={medium.icon} className="h-3 w-3" />
        ) : undefined
      }
      className={className}
    />
  )
}

export const LINE_STYLES: { value: DependencyLineStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
]

export function lineStyleLabel(v: string): string {
  return LINE_STYLES.find((s) => s.value === v)?.label ?? v
}
