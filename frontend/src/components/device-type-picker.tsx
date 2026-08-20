import { useMemo } from "react"

import type { DeviceType } from "@/lib/api"
import {
  ObjectPicker,
  type ObjectPickerProps,
  type ObjectPickerSpec,
} from "@/components/object-picker"
import { Badge } from "@/components/ui/badge"
import { TagList } from "@/components/cells/tag-list"

export interface DeviceTypePickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
}

/** The device-type preset of ObjectPicker.
 *
 * A catalog that starts empty ends up with hundreds of rows once a library is
 * imported, and the plain dropdown this replaces showed one unsearchable page -
 * so a type you owned could be genuinely unreachable (issue #40).
 *
 * The modal searches name, model and part number server-side, and filters by
 * manufacturer, platform, tag and artwork. Artwork matters more than it sounds:
 * a rack elevation only draws properly for a type that has images, so "which of
 * these can I actually render" is a real question when picking one. */
export function DeviceTypePicker({
  label = "Device type",
  ...rest
}: DeviceTypePickerProps) {
  const spec = useMemo<ObjectPickerSpec<DeviceType>>(
    () => ({
      noun: "device type",
      pickerEndpoint: "/api/device-types/?picker=1",
      pickerQueryKey: ["device-types-picker"],
      optionLabel: (t) =>
        // Two vendors ship a "2960"; the manufacturer is what tells them apart.
        (t as { manufacturer?: string }).manufacturer
          ? `${(t as { manufacturer?: string }).manufacturer} ${t.name}`
          : t.name,
      detailEndpoint: (id) => `/api/device-types/${id}/`,
      detailQueryKey: (id) => ["device-type", id],
      detailLabel: (t) =>
        t.manufacturer ? `${t.manufacturer.name} ${t.name}` : t.name,
      listEndpoint: "/api/device-types/",
      searchHint: "Search name, model, part number…",
      filters: [
        {
          key: "manufacturer",
          label: "Manufacturer",
          endpoint: "/api/manufacturers/?picker=1",
          queryKey: "manufacturers-picker",
        },
        {
          key: "platform",
          label: "Platform",
          endpoint: "/api/platforms/?picker=1",
          queryKey: "platforms-picker",
        },
        {
          key: "tag",
          label: "Tag",
          endpoint: "/api/tags/?picker=1",
          queryKey: "tags-picker",
          paramOf: (t: { slug: string }) => t.slug,
        },
        {
          key: "imagery",
          label: "Artwork",
          options: [
            { value: "front", label: "Has a front image" },
            { value: "rear", label: "Has a rear image" },
            { value: "both", label: "Has both images" },
            { value: "faceplate", label: "Has a drawn faceplate" },
            { value: "none", label: "No images" },
          ],
        },
      ],
      columns: [
        { header: "Name", cell: (t) => t.name },
        {
          header: "Manufacturer",
          cell: (t) => (
            <span className="text-muted-foreground">
              {t.manufacturer?.name ?? "-"}
            </span>
          ),
        },
        {
          header: "Part number",
          cell: (t) => (
            <span className="font-mono text-xs text-muted-foreground">
              {t.part_number || t.model || "-"}
            </span>
          ),
        },
        {
          header: "Height",
          cell: (t) => <span className="num">{t.u_height}U</span>,
        },
        {
          header: "Artwork",
          cell: (t) => {
            const has = [
              t.front_image && "Front",
              t.rear_image && "Rear",
              t.faceplate && "Faceplate",
            ].filter(Boolean) as string[]
            return has.length ? (
              <span className="flex flex-wrap gap-1">
                {has.map((h) => (
                  <Badge key={h} variant="outline" className="text-[10px]">
                    {h}
                  </Badge>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">-</span>
            )
          },
        },
        {
          header: "Tags",
          cell: (t) => <TagList tags={t.tags ?? []} />,
        },
        {
          header: "Devices",
          cell: (t) => <span className="num">{t.device_count ?? 0}</span>,
        },
      ],
    }),
    []
  )
  return <ObjectPicker<DeviceType> spec={spec} label={label} {...rest} />
}
