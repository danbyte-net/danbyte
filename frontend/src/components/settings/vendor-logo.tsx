import { useState } from "react"

import { VENDORS } from "@/lib/vendors"
import { cn } from "@/lib/utils"

/**
 * A vendor's own mark on an integration card, when this install has one.
 *
 * Danbyte ships no vendor artwork - naming a product to say what Danbyte
 * connects to is referential use, redistributing a mark to every install is
 * not - so nothing is committed here. An operator drops the file the vendor
 * publishes into `frontend/public/branding/vendors/`, which is ignored by
 * git, and the card picks it up.
 *
 * With no file there this renders **nothing**: an empty dashed box on every
 * card is worse than no box at all, and it reads as breakage rather than as
 * an invitation. The card lays out fine without it.
 *
 * 36px with its own padding, so a brandmark sits above the 20px floor
 * Proxmox sets for theirs and keeps its clear space.
 */
export function VendorLogo({
  vendor,
  className,
}: {
  vendor?: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const known = vendor ? VENDORS[vendor] : undefined
  const src = known?.logo

  if (!src || failed) return null
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background p-1",
        className
      )}
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  )
}
