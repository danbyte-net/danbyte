import { Fragment, useEffect, useId, useMemo, useReducer } from "react"
import type { KeyboardEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { Device, DinRail, Paginated } from "@/lib/api"
import { readableText } from "@/lib/color"
import {
  PROFILE_LABELS,
  deviceBody,
  fmtMm,
  freeGaps,
  railSpans,
} from "@/lib/din-geometry"
import type { RailSpan } from "@/lib/din-geometry"
import { cabinetPhotoBox, effectiveFrontCal } from "@/lib/photo-calibration"
import type { PlateBox } from "@/lib/photo-calibration"
import { cn } from "@/lib/utils"
import { usePlatePx } from "@/components/cabinet-elevation"
import { dash } from "@/components/cells/dash"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import type { DeviceColumnId } from "@/components/columns/device-columns"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// The devices in a cabinet (#277): one list per cabinet, shared by the plate
// drawing, the Devices tab and the per-rail actions, so a placement made in
// one shows in the others.

/** The devices in a cabinet, on its rails or off them. */
export function useCabinetDevices(cabinetId: string | null | undefined) {
  return useQuery({
    queryKey: ["cabinet-devices", cabinetId],
    queryFn: () =>
      api<Paginated<Device>>(
        `/api/devices/?cabinet=${cabinetId}&page_size=500`
      ),
    enabled: !!cabinetId,
  })
}

/** How the arrange mode marks a body: moved but not saved yet, or where it
 * would overlap another or not fit its rail. */
export type BodyMark = "moved" | "clash"

/** Screen pixels: the name's size, the strip it sits in, and its inset. */
const NAME_PX = 10
const STRIP_PX = 16
const INSET_PX = 3
/** A character of the name is about this wide, as a share of its size. */
const CHAR_EM = 0.6
/** A rail's label, as the plate writes it. */
const RAIL_LABEL_PX = 11

/** The name cut to what fits `lengthPx`, with the one-character ellipsis;
 * empty when not even three of its characters do. */
export function fitName(name: string, lengthPx: number): string {
  const room = Math.floor((lengthPx - 2 * INSET_PX) / (NAME_PX * CHAR_EM))
  if (name.length <= room) return name
  return room >= 4 ? `${name.slice(0, room - 1)}…` : ""
}

/** How a body carries its name: across its top while the name fits there;
 * else down its middle when the body stands tall and more of the name fits
 * that way - DIN gear is mostly narrow and tall, and the rack's side lane
 * writes its strips' names the same way. Cut to the room it has, or left
 * out under three characters. A photo keeps the name across its top, so the
 * picture stays whole. */
export function nameLayout(
  name: string,
  widthPx: number,
  heightPx: number,
  photo: boolean
): { text: string; vertical: boolean } | null {
  const across = heightPx >= STRIP_PX ? fitName(name, widthPx) : ""
  if (across !== name && !photo && widthPx >= STRIP_PX && heightPx > widthPx) {
    const down = fitName(name, heightPx)
    if (down.length > across.length) return { text: down, vertical: true }
  }
  return across ? { text: across, vertical: false } : null
}

/** Each photo's height over its width, once the browser has loaded it - a
 * calibrated photo's true height needs it, and the device rows carry only
 * its URL. Kept per URL for the session. */
const PHOTO_ASPECTS = new Map<string, number>()

/** The front photos of `devices` drawn at their true size: the ones whose
 * aspect a drawing has to wait for. */
export function calibratedPhotos(devices: Device[]): string[] {
  return devices.flatMap((d) =>
    d.device_type?.front_image && effectiveFrontCal(d)
      ? [d.device_type.front_image]
      : []
  )
}

/** Where a device's front photo is drawn on the plate: stretched over its
 * body, or - calibrated (#277) - at its true size, its left guide on the
 * body's left edge and its rail line on the rail, `box` null until the
 * photo has loaded and given its height. Null for a type with no photo. */
export function frontPhoto(
  d: Device,
  rail: Pick<DinRail, "y_mm">,
  body: PlateBox,
  aspects: ReadonlyMap<string, number>
): { href: string; calibrated: boolean; box: PlateBox | null } | null {
  const href = d.device_type?.front_image
  if (!href) return null
  const cal = effectiveFrontCal(d)
  if (!cal) return { href, calibrated: false, box: body }
  const aspect = aspects.get(href)
  return {
    href,
    calibrated: true,
    box: aspect ? cabinetPhotoBox(body, cal, aspect, rail.y_mm) : null,
  }
}

/** The aspects of `urls`, loading the ones not known yet; re-renders as
 * each arrives. */
export function usePhotoAspects(urls: string[]): ReadonlyMap<string, number> {
  const key = [...new Set(urls)].sort().join("\n")
  const [, loaded] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!key) return
    let live = true
    for (const url of key.split("\n")) {
      if (PHOTO_ASPECTS.has(url)) continue
      const img = new Image()
      img.onload = () => {
        if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return
        PHOTO_ASPECTS.set(url, img.naturalHeight / img.naturalWidth)
        if (live) loaded()
      }
      img.src = url
    }
    return () => {
      live = false
    }
  }, [key])
  return PHOTO_ASPECTS
}

/** How the bodies are drawn: their type's front photo where it has one,
 * or always the role's colour. */
export type BodyLook = "images" | "names"

/**
 * The devices on a cabinet's rails, drawn over its plate - the elevation's
 * `children`. A body sits at its rail's left end plus its offset, as wide and
 * tall as its type, its type's rail position on the rail's centreline. It
 * shows the type's front photo, stretched to the body, or the device role's
 * colour; hover for the numbers, click through to the device. Devices off a
 * rail have no place on the plate and are left out.
 *
 * A calibrated photo (#277) is drawn at its true size instead: its left
 * guide on the body's left edge, its rail line on the rail, clipped to the
 * body. It waits for the photo to load, which gives its height.
 *
 * It writes the rails' labels too (the elevation's own go, `railLabels`
 * off): a rail's first device sits at its left end, where the label was, so
 * each label moves to the first stretch of its rail left free - over the
 * devices, on a backdrop, only on a full rail.
 */
export function CabinetDeviceBodies({
  rails,
  devices,
  look = "images",
  names = true,
  railTags = true,
  highlight,
  interactive = true,
  keepClear = [],
  marks,
  onPick,
}: {
  /** `dimmed` writes a rail's label faint, as the elevation draws the rail. */
  rails: (DinRail & { dimmed?: boolean })[]
  devices: Device[]
  /** "names" leaves the photos out: every body in its role's colour. */
  look?: BodyLook
  /** Write each device's name on its body. */
  names?: boolean
  /** Write the rails' labels. */
  railTags?: boolean
  /** Drawn in the selection colour - the device whose page this is. */
  highlight?: string | null
  /** Off: drawn only - no links, no hovers, no tab stops. The device form's
   * plate, where a press places the device being edited instead. */
  interactive?: boolean
  /** Stretches of rails the labels stay off as they stay off devices - the
   * device the form is placing. */
  keepClear?: { railId: string; span: RailSpan }[]
  /** Bodies drawn moved or clashing, by device id. */
  marks?: Record<string, BodyMark>
  /** With `interactive` off: Enter or Space on a body picks it - the
   * arrange mode's way in from the keyboard. */
  onPick?: (d: Device) => void
}) {
  const px = usePlatePx()
  const nav = useNavigate()
  const clipId = useId()
  const railById = new Map(rails.map((r) => [r.id, r]))
  const photos = look === "images"
  const aspects = usePhotoAspects(photos ? calibratedPhotos(devices) : [])
  const tagged = railTags ? rails : []
  const open = (d: Device) => nav({ to: "/devices/$id", params: { id: d.id } })
  const onKey = (d: Device, e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    void open(d)
  }
  // The highlighted device last, so nothing on another rail covers it.
  const ordered = [...devices].sort(
    (a, b) => Number(a.id === highlight) - Number(b.id === highlight)
  )

  return (
    <g data-part="devices">
      {ordered.map((d) => {
        const rail = d.din_rail ? railById.get(d.din_rail.id) : undefined
        const body = rail
          ? deviceBody(rail, d.din_offset_mm, d.device_type)
          : null
        if (!rail || !body) return null
        const placed = photos ? frontPhoto(d, rail, body, aspects) : null
        const photo = placed?.href ?? null
        const clip = `${clipId}-${d.id}`
        const fill = photo ? null : d.role?.color || null
        const ink = fill ? readableText(fill) : undefined
        const selected = d.id === highlight
        const mark = marks?.[d.id]
        const label = names
          ? nameLayout(d.name, body.width / px(1), body.height / px(1), !!photo)
          : null
        const cx = body.x + body.width / 2
        const cy = label?.vertical
          ? body.y + body.height / 2
          : body.y + px(STRIP_PX / 2)
        const shape = (
          <g
            key={d.id}
            data-device={d.name}
            data-selected={selected || undefined}
            {...(interactive && {
              role: "link",
              tabIndex: 0,
              "aria-label": d.name,
              onClick: () => void open(d),
              onKeyDown: (e: KeyboardEvent<SVGGElement>) => onKey(d, e),
            })}
            {...(!interactive &&
              onPick && {
                role: "button",
                tabIndex: 0,
                "aria-label": d.name,
                onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
                  if (e.key !== "Enter" && e.key !== " ") return
                  e.preventDefault()
                  onPick(d)
                },
              })}
            className={cn(
              "group/body outline-none",
              interactive ? "cursor-pointer" : "pointer-events-none"
            )}
          >
            {placed?.calibrated ? (
              placed.box && (
                <>
                  <defs>
                    <clipPath id={clip}>
                      <rect
                        x={body.x}
                        y={body.y}
                        width={body.width}
                        height={body.height}
                      />
                    </clipPath>
                  </defs>
                  <image
                    data-part="photo"
                    data-calibrated=""
                    href={placed.href}
                    x={placed.box.x}
                    y={placed.box.y}
                    width={placed.box.width}
                    height={placed.box.height}
                    preserveAspectRatio="none"
                    clipPath={`url(#${clip})`}
                  />
                </>
              )
            ) : photo ? (
              <image
                href={photo}
                x={body.x}
                y={body.y}
                width={body.width}
                height={body.height}
                preserveAspectRatio="none"
              />
            ) : (
              <rect
                data-part="body"
                x={body.x}
                y={body.y}
                width={body.width}
                height={body.height}
                className={fill ? undefined : "fill-card"}
                style={fill ? { fill } : undefined}
              />
            )}
            {label && photo && (
              <rect
                x={body.x}
                y={body.y}
                width={body.width}
                height={px(STRIP_PX)}
                className="fill-background/85"
              />
            )}
            {label && (
              <text
                data-part="name"
                x={cx}
                y={cy}
                transform={
                  label.vertical ? `rotate(90 ${cx} ${cy})` : undefined
                }
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={px(NAME_PX)}
                className={cn(
                  "pointer-events-none font-medium",
                  !ink && "fill-foreground"
                )}
                style={ink ? { fill: ink } : undefined}
              >
                {label.text}
              </text>
            )}
            {mark === "clash" && (
              <rect
                x={body.x}
                y={body.y}
                width={body.width}
                height={body.height}
                className="fill-destructive/25"
              />
            )}
            {/* The outline on top, so a photo gets one too. */}
            <rect
              data-part="outline"
              data-mark={mark}
              x={body.x}
              y={body.y}
              width={body.width}
              height={body.height}
              className={cn(
                "fill-none",
                mark === "clash"
                  ? "stroke-destructive"
                  : mark === "moved" || selected
                    ? "stroke-primary"
                    : "stroke-border group-hover/body:stroke-foreground/60 group-focus-visible/body:stroke-primary"
              )}
              strokeWidth={selected || mark ? 2 : 1}
              strokeDasharray={mark === "moved" ? "4 3" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
        if (!interactive) return shape
        return (
          <Tooltip key={d.id}>
            <TooltipTrigger asChild>{shape}</TooltipTrigger>
            <TooltipContent variant="panel" side="top">
              <DeviceNumbers device={d} rail={rail} />
            </TooltipContent>
          </Tooltip>
        )
      })}
      <g data-part="rail-tags" className="pointer-events-none">
        {tagged.map((r) => {
          const at = railTagAt(
            r,
            devices,
            px,
            keepClear.filter((k) => k.railId === r.id).map((k) => k.span)
          )
          return (
            <g key={r.id} data-rail-tag={r.label}>
              {at.covered && (
                <rect
                  x={r.x_mm + px(3)}
                  y={r.y_mm - px(7)}
                  width={at.width - px(2)}
                  height={px(14)}
                  rx={px(2)}
                  className="fill-background/85"
                />
              )}
              <text
                x={r.x_mm + at.offset + px(6)}
                y={r.y_mm}
                dominantBaseline="central"
                fontSize={px(RAIL_LABEL_PX)}
                className={cn(
                  "font-medium",
                  r.dimmed ? "fill-muted-foreground/60" : "fill-foreground"
                )}
              >
                {r.label}
              </text>
            </g>
          )
        })}
      </g>
    </g>
  )
}

/** Where a rail's label goes, from its left end: the first free stretch it
 * fits in, or - on a full rail - the left end, `covered`, over the first
 * device. `width` is what the label takes, in plate mm. */
export function railTagAt(
  rail: DinRail,
  devices: Device[],
  px: (n: number) => number,
  /** More of the rail to stay off, besides its devices. */
  also: RailSpan[] = []
): { offset: number; width: number; covered: boolean } {
  const width = px(rail.label.length * RAIL_LABEL_PX * CHAR_EM + 9)
  const taken = [
    ...railSpans(devices.filter((d) => d.din_rail?.id === rail.id)),
    ...also,
  ]
  const gap = freeGaps(rail.length_mm, taken).find(
    ([start, end]) => end - start >= width
  )
  return gap
    ? { offset: gap[0], width, covered: false }
    : { offset: 0, width, covered: true }
}

/** A device's type and place, for its hover - the rail's hover, for a
 * device. */
function DeviceNumbers({ device: d, rail }: { device: Device; rail: DinRail }) {
  const rows: [string, string][] = [
    ["Rail", rail.label],
    ["Offset", `${fmtMm(d.din_offset_mm ?? 0)} mm`],
  ]
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline gap-2 font-medium">
        {d.name}
        {d.device_type && (
          <span className="font-normal text-muted-foreground">
            {d.device_type.name}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="num text-right">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

/** The devices in a cabinet, as the rack page lists a rack's: the shared
 * device cells, with the rail and offset spliced in after the name. */
export function CabinetDevicesPane({ cabinetId }: { cabinetId: string }) {
  const q = useCabinetDevices(cabinetId)
  const rows = q.data?.results ?? []
  const columns = useMemo<ColumnDef<Device>[]>(() => {
    const shared = buildDeviceColumns({
      include: ["name", "role", "type", "status"],
    })
    const col = (id: DeviceColumnId) => shared.filter((c) => c.id === id)
    return [
      ...col("name"),
      {
        id: "din_rail",
        accessorFn: (d) => d.din_rail?.label ?? "",
        header: ({ column }) => <SortHeader column={column} label="Rail" />,
        cell: ({ row }) => {
          const r = row.original.din_rail
          if (!r) return dash
          return (
            <span className="inline-flex items-baseline gap-1.5 text-xs">
              <span className="font-medium">{r.label}</span>
              <span className="text-muted-foreground">
                {PROFILE_LABELS[r.profile]}
              </span>
            </span>
          )
        },
      },
      {
        id: "din_offset_mm",
        accessorFn: (d) => d.din_offset_mm ?? undefined,
        sortUndefined: "last",
        header: ({ column }) => <SortHeader column={column} label="Offset" />,
        cell: ({ row }) =>
          row.original.din_offset_mm != null ? (
            <span className="num text-xs">
              {fmtMm(row.original.din_offset_mm)} mm
            </span>
          ) : (
            dash
          ),
      },
      ...col("role"),
      ...col("type"),
      ...col("status"),
    ]
  }, [])
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return <EmptyState title="No devices in this cabinet." />
  return <DataTable data={rows} columns={columns} flexColumn="name" embedded />
}
