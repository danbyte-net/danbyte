import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { Scaling } from "lucide-react"

import { api } from "@/lib/api"
import type { Cabinet, FloorPlanTile } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { CabinetPicker } from "@/components/cabinet-picker"

import { cabinetTileSize } from "./cabinet-tile"

/**
 * The tile inspector's link to a DIN-rail cabinet: the cabinet picker,
 * limited to the plan's site, and - once a cabinet is picked - an offer to
 * size the tile to the cabinet's footprint on this plan's grid, when the
 * tile is not that size already.
 *
 * A freshly picked cabinet's name is filled in on the tile's link as soon
 * as it is known, so the tile's label falls back to it before the plan is
 * saved, as it does after.
 */
export function CabinetLinkField({
  tile,
  siteId,
  cellMm,
  onPick,
  onName,
  onFit,
}: {
  tile: FloorPlanTile
  /** The plan's site - a cabinet elsewhere cannot stand on this floor. */
  siteId?: string | null
  /** The plan's cell size, mm. */
  cellMm: number
  onPick: (id: string | null) => void
  /** The linked cabinet's name, for a link that does not carry it yet. */
  onName: (name: string) => void
  /** Size the tile to the cabinet, in cells. */
  onFit: (size: { width: number; height: number }) => void
}) {
  const id = tile.linked?.kind === "cabinet" ? tile.linked.id : null
  // The picker reads the same cabinet under this key, so this is no extra
  // request once it has.
  const q = useQuery({
    queryKey: ["cabinet", id],
    queryFn: () => api<Cabinet>(`/api/cabinets/${id}/`),
    enabled: !!id,
    staleTime: 60_000,
  })
  const cabinet = id && q.data?.id === id ? q.data : null

  const missingName = !!tile.linked && !tile.linked.name
  useEffect(() => {
    if (cabinet && missingName) onName(cabinet.name)
  }, [cabinet, missingName, onName])

  const fit = cabinet
    ? cabinetTileSize(cabinet, cellMm, tile.orientation)
    : null
  const offer =
    fit && (fit.width !== tile.width || fit.height !== tile.height) ? fit : null

  return (
    <>
      <CabinetPicker
        label="Cabinet"
        value={id}
        siteId={siteId}
        onChange={onPick}
      />
      {offer && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => onFit(offer)}
        >
          <Scaling className="h-3.5 w-3.5" /> Fit to cabinet
          <span className="num text-muted-foreground">
            {offer.width}×{offer.height}
          </span>
        </Button>
      )}
    </>
  )
}
