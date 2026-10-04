import type { RefObject } from "react"

import { DrawingExportMenu } from "@/components/drawing-export-menu"
import type { DrawingRequest } from "@/components/drawing-export-menu"
import type { Cabinet, Device } from "@/lib/api"
import type { PlateMode } from "@/lib/cabinet-plate-view"
import { exportFileName } from "@/lib/diagram/export-file"
import { downloadPng } from "@/lib/png-export"

// A cabinet's Export menu (#277): the plate as the SVG, PNG and PDF exports
// draw it (lib/elevation/cabinet-svg.ts) - the mode and labels the page
// shows, Render drawn in the Images look, whose PNG is a picture of the
// screen instead.

export function CabinetExportMenu({
  cabinet,
  devices,
  mode,
  labels,
  railTags,
  snapshot,
  className,
}: {
  cabinet: Cabinet
  devices: Device[]
  mode: PlateMode
  /** Each device's name on its body. */
  labels: boolean
  /** The rails' labels. */
  railTags: boolean
  /** The drawing on screen: Render's PNG is a picture of it. */
  snapshot?: RefObject<HTMLElement | null>
  className?: string
}) {
  const look = mode === "names" ? "names" : "images"
  const name = `${cabinet.name} plate`
  const picture = mode === "render" && snapshot

  const build = async ({ fonts, heading }: DrawingRequest) => {
    const [{ cabinetPhotoRequests, cabinetSvg }, { inlinePhotos }] =
      await Promise.all([
        import("@/lib/elevation/cabinet-svg"),
        import("@/lib/elevation/photos"),
      ])
    const { photos, missing } = await inlinePhotos(
      cabinetPhotoRequests(cabinet, devices, { look })
    )
    const svg = cabinetSvg(cabinet, devices, {
      look,
      labels,
      railTags,
      photos,
      heading,
      emptyText: "No rails yet.",
      generatedAt: new Date().toISOString(),
      embedFont: fonts,
    })
    return { svg, missing }
  }

  const shoot = async () => {
    const el = snapshot?.current
    if (el)
      await downloadPng(el, exportFileName(name, "png", undefined, "cabinet"))
  }

  return (
    <DrawingExportMenu
      name={name}
      build={build}
      pdfUrl={`/api/cabinets/${cabinet.id}/export/pdf/`}
      paperKey="cabinet:export"
      defaultPaper={{ size: "a4", orientation: "landscape" }}
      snapshot={picture ? shoot : undefined}
      note={
        mode !== "render"
          ? undefined
          : picture
            ? "SVG and PDF in the Images look"
            : "Exports in the Images look"
      }
      className={className}
    />
  )
}
