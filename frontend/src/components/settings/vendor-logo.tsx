import { useState } from "react"

import { VENDORS } from "@/lib/vendors"
import { cn } from "@/lib/utils"

/**
 * A vendor's own mark on an integration card, when this install has one.
 *
 * Danbyte ships no vendor artwork - naming a product to say what Danbyte
 * connects to is referential use, redistributing a mark to every install is
 * not - so nothing is committed here. An operator drops the files the vendor
 * publishes into `frontend/public/branding/vendors/`, which git ignores, and
 * the card picks them up.
 *
 * With no file there this renders **nothing**: an empty box on every card is
 * worse than no box, and reads as breakage rather than as an invitation.
 *
 * Positive and negative variants swap with the theme, because that is what
 * a guideline shipping both actually asks for - a positive mark on a dark
 * card is the commonest way to get someone's logo wrong. The mark gets its
 * own padding so the clear space it is drawn with survives.
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
  const light = known?.logo
  const dark = known?.logoDark ?? light

  if (!light || failed) return null
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center p-0.5",
        className
      )}
    >
      <img
        src={light}
        alt=""
        aria-hidden="true"
        className="max-h-full max-w-full object-contain dark:hidden"
        onError={() => setFailed(true)}
      />
      <img
        src={dark}
        alt=""
        aria-hidden="true"
        className="hidden max-h-full max-w-full object-contain dark:block"
      />
    </span>
  )
}
