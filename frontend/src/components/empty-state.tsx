import { cn } from "@/lib/utils"

// Canonical empty-state card. Copy convention: title is "No {plural} yet."
// — children carry the optional call-to-action or explanation.
export function EmptyState({
  title,
  children,
  className,
}: {
  title: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-border p-8 text-center",
        className
      )}
    >
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <div className="mt-1 text-sm text-muted-foreground">{children}</div>
      )}
    </div>
  )
}
