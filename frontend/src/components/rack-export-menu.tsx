import type { RefObject } from "react"
import { useQuery } from "@tanstack/react-query"

import { DrawingExportMenu } from "@/components/drawing-export-menu"
import type { DrawingRequest } from "@/components/drawing-export-menu"
import { api } from "@/lib/api"
import type { Device, Paginated, Rack } from "@/lib/api"
import { exportFileName } from "@/lib/diagram/export-file"
import { downloadPng } from "@/lib/png-export"

// A rack's Export menu (#248): the elevation as the SVG, PNG and PDF exports
// draw it (lib/elevation/rack-svg.ts) - the faces and mode the page shows,
// Render drawn in the Images look, whose PNG is a picture of the screen
// instead. The devices are the elevation's own list, from the same query.

export type RackExportFace = "front" | "rear" | "both"

/** The rack's devices, as the elevation fetches them - one cache entry. */
function useRackDevices(rackId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["rack-devices", rackId],
    queryFn: () => api<Paginated<Device>>(`/api/devices/?rack=${rackId}`),
    enabled,
  })
}

export function RackExportMenu({
  rack,
  devices,
  face = "both",
  mode,
  labels = true,
  snapshot,
  className,
}: {
  rack: Rack
  /** The rack's devices; fetched as the elevation fetches them when left
   * out. */
  devices?: Device[]
  /** The faces drawn: front and rear side by side, as the rack page shows
   * them, or one. */
  face?: RackExportFace
  mode: "names" | "images" | "render"
  /** Images: each photo's name on it. */
  labels?: boolean
  /** The drawing on screen: Render's PNG is a picture of it. */
  snapshot?: RefObject<HTMLElement | null>
  className?: string
}) {
  const q = useRackDevices(rack.id, !devices)
  const list = devices ?? q.data?.results
  const look = mode === "names" ? "names" : "images"
  const name = `${rack.name} elevation`
  const picture = mode === "render" && snapshot

  const build = async ({ fonts, heading }: DrawingRequest) => {
    if (!list) return null
    const [{ rackPhotoRequests, rackSvg }, { inlinePhotos }] =
      await Promise.all([
        import("@/lib/elevation/rack-svg"),
        import("@/lib/elevation/photos"),
      ])
    const faces = face === "both" ? (["front", "rear"] as const) : [face]
    const { photos, missing } = await inlinePhotos(
      rackPhotoRequests(rack, list, { faces, look })
    )
    const svg = rackSvg(rack, list, {
      faces,
      look,
      labels,
      photos,
      heading,
      generatedAt: new Date().toISOString(),
      embedFont: fonts,
    })
    return { svg, missing }
  }

  const shoot = async () => {
    const el = snapshot?.current
    if (el)
      await downloadPng(el, exportFileName(name, "png", undefined, "rack"))
  }

  return (
    <DrawingExportMenu
      name={name}
      build={build}
      pdfUrl={`/api/racks/${rack.id}/export/pdf/`}
      paperKey="rack:export"
      defaultPaper={{ size: "a4", orientation: "portrait" }}
      snapshot={picture ? shoot : undefined}
      note={
        mode !== "render"
          ? undefined
          : picture
            ? "SVG and PDF in the Images look"
            : "Exports in the Images look"
      }
      disabled={!list}
      className={className}
    />
  )
}
