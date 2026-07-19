import { cn } from "@/lib/utils"

export interface FormRowProps {
  /** Number of equal-width columns. Default 2. */
  cols?: 2 | 3 | 4
  className?: string
  children: React.ReactNode
}

// Equal-width column row for grouping related fields side-by-side.
export function FormRow({ cols = 2, className, children }: FormRowProps) {
  const grid =
    cols === 2 ? "grid-cols-2" : cols === 3 ? "grid-cols-3" : "grid-cols-4"
  return <div className={cn("grid gap-3", grid, className)}>{children}</div>
}
