import { VENDORS } from "@/lib/vendors"
import { cn } from "@/lib/utils"

/**
 * The logo slot on an integration card.
 *
 * Danbyte ships no vendor artwork - a name in text is referential use, a
 * redistributed mark is not - so this draws the space a logo will occupy and
 * fills it with the vendor's initials until an operator uploads one for
 * their own install. The dashed edge says "nothing here yet" without
 * pretending to be a broken image.
 *
 * Sized at 36px: above the 20px floor Proxmox sets for its brandmark, and
 * with its own clear space, so an uploaded mark sits inside a guideline
 * rather than against one. */
export function VendorLogo({
  vendor,
  className,
}: {
  vendor?: string
  className?: string
}) {
  const known = vendor ? VENDORS[vendor] : undefined
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed border-border bg-muted/40 p-1 font-mono text-[11px] text-muted-foreground",
        className
      )}
    >
      {known?.initials ?? "·"}
    </span>
  )
}
