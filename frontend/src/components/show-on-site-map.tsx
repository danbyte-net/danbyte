import { Link } from "@tanstack/react-router"
import { MapPin } from "lucide-react"

import { Button } from "@/components/ui/button"

/** "Show on site map" — jumps to the geographic Site map centered on this
 *  device. Rendered only when the device has coordinates. */
export function ShowOnSiteMap({
  deviceId,
  hasCoords,
}: {
  deviceId: string
  hasCoords: boolean
}) {
  if (!hasCoords) return null
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/site-map" search={{ focus: deviceId }}>
        <MapPin className="h-3.5 w-3.5" /> Site map
      </Link>
    </Button>
  )
}
