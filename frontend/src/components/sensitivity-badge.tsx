import { ColorBadge } from "@/components/cells/color-badge"
import { NamedIcon } from "@/components/dynamic-icon"

/** A sensitivity label as its pill: its colour, its icon and its name -
 * the same badge in the catalog, its page and the report dialog. */
export function SensitivityBadge({
  label,
  className,
}: {
  label: { name: string; color?: string | null; icon?: string | null }
  className?: string
}) {
  return (
    <ColorBadge
      name={label.name}
      color={label.color || undefined}
      icon={
        label.icon ? (
          <NamedIcon name={label.icon} className="h-3 w-3" />
        ) : undefined
      }
      className={className}
    />
  )
}
