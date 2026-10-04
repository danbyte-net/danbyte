import { lazy, memo, Suspense } from "react"
import { Handle, Position, useStore } from "@xyflow/react"
import type { NodeProps, ReactFlowState } from "@xyflow/react"

import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { StatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"
import { cardContent } from "./card-fields"
import { CARD, NUB, nubRect, PILL } from "./card-layout"
import { captionWith, PHOTO } from "./photo-anchors"
import type { DiagramCardData } from "./types"

// A device drawn as its front photo (photo-anchors.ts): the image to
// scale, a thin outline on each port a cable is plugged into, a grey tab
// on the image edge for a cabled port without a marker, and the name as a
// caption under the image - its card lines after it, muted, then the
// status pill, which wins any room the lines took from it; a cut caption
// names itself in full on hover. No card fill.
// Taking its cables at its edge, it has no outlines: in Detailed mode each
// cable leaves a nub on the image's side, as on a card.
//
// The cables themselves start at the ports: their leads over the image
// are drawn by the link edge. Far out (zoom under `photoLod`) the image
// gives way to a plain box, edged and tinted in the device's role colour
// so the map still shows where each device is. A type with no photo shows
// its schematic faceplate instead, on screen only - never artwork made up
// here.

const HANDLE =
  "!pointer-events-none !h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent !opacity-0"

/** The pill at caption scale - the card's. */
const STATUS_PILL =
  "block h-4 max-w-24 shrink-0 truncate px-1.5 py-0 text-[9px] leading-[14px]"
const CHECK_PILL = "h-4 max-w-24 px-[7px] text-[9px] leading-[14px]"

/** The schematic faceplate: loaded with the first node that needs one. */
const TypeFaceplate = lazy(() =>
  import("@/components/device-faceplate").then((m) => ({
    default: m.TypeFaceplate,
  }))
)

export const PhotoNode = memo(function PhotoNode({
  data,
  selected,
}: NodeProps) {
  const d = data as DiagramCardData
  const { box, nubs } = d.diagram
  const ph = d.diagram.photo!
  // Far out the photos are boxes, never decoded images. A yes/no, so a
  // zoom re-renders a photo only when it crosses the line.
  const far = useStore((s: ReactFlowState) => s.transform[2] < ph.lod)
  const { pill } = cardContent(d, { monitor: d.monitor })
  // A pill that shows takes back the room its lines may have used.
  const cap = captionWith(ph.caption, !!pill)
  const fill = box.fill
  const plain = (
    <div
      className={cn(
        "topo-photo-lod size-full rounded-sm border",
        fill ? "" : "border-muted-foreground/50 bg-muted"
      )}
      style={
        fill
          ? {
              borderColor: fill,
              backgroundColor: `color-mix(in srgb, ${fill} 28%, transparent)`,
            }
          : undefined
      }
    />
  )
  return (
    <div
      className={cn("relative transition-opacity", d.dimmed && "opacity-30")}
      style={{ width: box.w, height: box.h }}
      data-card={d.device_id}
      data-photo={ph.kind}
    >
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={HANDLE}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={HANDLE}
      />
      <div
        className={cn(
          "absolute inset-x-0 top-0",
          selected && "outline-2 outline-offset-2 outline-map-accent"
        )}
        style={{ height: ph.imgH }}
      >
        {far ? (
          plain
        ) : ph.kind === "photo" && ph.url ? (
          // The box has the photo's own aspect: nothing is distorted, and
          // the markers land where they were placed.
          <img
            src={ph.url}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            className="pointer-events-none size-full select-none"
            style={{ objectFit: "fill" }}
          />
        ) : ph.typeId ? (
          // The faceplate is port outlines only: the node's own frame
          // shows where the device is.
          <div
            className="flex size-full items-center overflow-hidden rounded-sm border border-border bg-card"
            data-faceplate
          >
            <Suspense fallback={plain}>
              <TypeFaceplate
                deviceTypeId={ph.typeId}
                pxPerMm={PHOTO.W / PHOTO.RACK_MM}
                vcPosition={ph.vc ?? null}
                compact
              />
            </Suspense>
          </div>
        ) : (
          plain
        )}
        {ph.marks.map((m) => (
          <span
            key={`${m.kind}:${m.port}`}
            className="topo-mark absolute rounded-[2px] border border-primary/70"
            style={{
              left: `${(m.x - m.w / 2) * 100}%`,
              top: `${(m.y - m.h / 2) * 100}%`,
              width: `${m.w * 100}%`,
              height: `${m.h * 100}%`,
            }}
            data-port={m.port}
            data-tip={m.port}
          />
        ))}
      </div>
      {ph.stubs.map((s) => (
        <span
          key={`${s.side}${s.x}`}
          className="topo-nub absolute rounded-[2px] bg-muted-foreground/70"
          style={{
            left: s.x - NUB.ALONG / 2,
            top: s.side === "T" ? -NUB.OUT : ph.imgH,
            width: NUB.ALONG,
            height: NUB.OUT,
          }}
          data-port={s.port}
          data-tip={s.port || undefined}
        />
      ))}
      {nubs.map((n) => {
        // On the image's sides: the caption is under it.
        const r = nubRect(box.w, ph.imgH, n.side, n.off)
        return (
          <span
            key={`${n.link}#${n.cable}${n.end}`}
            className="topo-nub absolute rounded-[2px] bg-muted-foreground/70"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            data-port={n.port}
            data-tip={n.port}
          />
        )
      })}
      <div
        className="absolute flex items-center whitespace-nowrap"
        style={{ left: cap.x, top: cap.top, height: PHOTO.CAPTION_LH }}
        data-tip={cap.full}
      >
        <span
          className="font-bold text-foreground"
          style={{
            fontSize: CARD.TITLE_SIZE,
            lineHeight: `${PHOTO.CAPTION_LH}px`,
          }}
        >
          {cap.text}
        </span>
        {cap.tail && (
          <span
            className="text-muted-foreground"
            style={{
              marginLeft: PHOTO.TAIL_GAP,
              fontSize: CARD.LINE_SIZE,
              lineHeight: `${PHOTO.CAPTION_LH}px`,
            }}
          >
            {cap.tail.text}
          </span>
        )}
        {pill && (
          <span className="flex" style={{ marginLeft: PILL.GAP }}>
            {pill.kind === "check" ? (
              <CheckStatusBadge status={pill.status} className={CHECK_PILL} />
            ) : (
              <StatusBadge status={pill.status} className={STATUS_PILL} />
            )}
          </span>
        )}
      </div>
    </div>
  )
})
