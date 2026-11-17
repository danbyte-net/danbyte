import { Suspense, lazy, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { AccessoryType, PortParts } from "@/lib/api"
import { endColours, isApc } from "@/lib/fibre-colours"
import type { RecolourChannel } from "@/lib/fibre-colours"
import {
  CABLE_PREVIEWS,
  cordSeatNames,
  defaultPreview,
  previewColours,
} from "@/lib/pluggable-preview"
import { BarMenuTrigger, BarToggle } from "@/components/map-toolbar"
import {
  LazyModelViewer,
  ModelViewerFrame,
} from "@/components/model-viewer-card"
import type { ViewerSource } from "@/components/model-viewer-card"
import { Loading } from "@/components/loading"
import { Section } from "@/components/ui/section"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// three.js stays in the 3D chunk.
const LazyPartOverlay = lazy(
  () => import("@/components/floorplan3d/part-overlay")
)

/** The viewer's source for one part: as authored (metres, +Z out of the
 * port, +Y up), recoloured, with a seated cord. */
function partSource(
  url: string,
  colours: Record<RecolourChannel, string>,
  cord: { url: string; names: readonly string[] } | null
): ViewerSource {
  return {
    model: { url, fit: "native", up: "y", front: "+z" },
    overlay: (root) => (
      <Suspense fallback={null}>
        <LazyPartOverlay root={root} colours={colours} cord={cord} />
      </Suspense>
    ),
  }
}

/**
 * The Pluggables page's "3D model" card (docs/dcim/pluggables.md): the
 * part in the shared viewer frame (Front / Top / 3D, fullscreen), with a
 * "With cord" toggle that seats the matching cord at the transceiver's
 * `port:<connector>` empty, as a device's port shows it, and a Cable type
 * picker that previews the `FIBRE` / `LC_BODY` / `CABLE` colours.
 */
export function PluggableModelCard({ part }: { part: AccessoryType }) {
  const [preview, setPreview] = useState(() => defaultPreview(part))
  const cordOf = part.cord?.model_url ? part.cord : null
  const [withCord, setWithCord] = useState(!!cordOf)
  const connector = cordOf?.connector ?? part.connector
  const colours = useMemo(
    () => previewColours(preview, connector),
    [preview, connector]
  )
  const cord = useMemo(
    () =>
      withCord && cordOf
        ? {
            url: cordOf.model_url!,
            names: cordSeatNames(cordOf.connector, part.connector),
          }
        : null,
    [withCord, cordOf, part.connector]
  )
  if (!part.model_url) return null
  const label =
    CABLE_PREVIEWS.find((p) => p.value === preview)?.label ?? "Neutral"
  return (
    <Section title="3D model">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ModelViewerFrame
          source={partSource(part.model_url, colours, cord)}
          tools={
            <>
              {cordOf && (
                <BarToggle
                  pressed={withCord}
                  onClick={() => setWithCord((v) => !v)}
                >
                  With cord
                </BarToggle>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <BarMenuTrigger>Cable: {label}</BarMenuTrigger>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={preview}
                    onValueChange={setPreview}
                  >
                    {CABLE_PREVIEWS.map((p) => (
                      <DropdownMenuRadioItem key={p.value} value={p.value}>
                        {p.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />
      </div>
    </Section>
  )
}

/**
 * The interface page's Transceiver row thumbnail: the exact part the port
 * shows (api.port_plugs.port_parts) - with its cord while cabled, coloured
 * by the cable - turned by dragging, with the part's name under it linking
 * to its Pluggables page when the reader may open it. Nothing while the
 * port shows no part.
 */
export function PortPartThumb({ interfaceId }: { interfaceId: string }) {
  const q = useQuery({
    queryKey: ["interface-parts", interfaceId],
    queryFn: () => api<PortParts>(`/api/interfaces/${interfaceId}/parts/`),
    staleTime: 60_000,
  })
  const p = q.data
  const main = p?.transceiver_part ?? p?.cord_part ?? null
  const source = useMemo(() => {
    if (!p || !main) return null
    const colours = endColours({
      color: p.color,
      cableType: p.cable_type,
      apc: isApc(p.port_type, p.cord_part?.connector),
    })
    const cord =
      p.transceiver_part && p.cord_part
        ? {
            url: p.cord_part.url,
            names: cordSeatNames(
              p.cord_part.connector,
              p.transceiver_part.connector
            ),
          }
        : null
    return partSource(main.url, colours, cord)
  }, [p, main])
  if (!source || !main) return null
  const viewer = (
    <Suspense fallback={<Loading className="h-24 w-36" label={false} />}>
      <LazyModelViewer
        {...source}
        markers={false}
        view={{ preset: "iso", n: 0 }}
        className="h-24 w-36"
      />
    </Suspense>
  )
  // The view turns on drag, so it is no link itself (a drag would grab the
  // link); the part's name under it opens the part.
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="block overflow-hidden rounded-md border border-border bg-card">
        {viewer}
      </span>
      {main.id && (
        <Link
          to="/pluggables/$id"
          params={{ id: main.id }}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {main.name}
        </Link>
      )}
    </span>
  )
}
