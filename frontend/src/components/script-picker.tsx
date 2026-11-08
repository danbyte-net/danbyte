import { useMemo } from "react"

import type { Script } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"

export interface ScriptPickerProps extends Omit<ObjectPickerProps, "label"> {
  label?: string
  /** Grey out scripts without a `device_ids` parameter (deploy targets). */
  needsDeviceIds?: boolean
}

const ENDPOINT = "/api/scripts/"

const hasDeviceIds = (s: Script) =>
  s.params_schema.some((p) => p.name === "device_ids")

/** The script preset of ObjectPicker - the scripts the caller can see. */
export function ScriptPicker({
  label = "Script",
  needsDeviceIds = false,
  ...rest
}: ScriptPickerProps) {
  const spec = useMemo<ObjectPickerSpec<Script, Script>>(
    () => ({
      noun: "script",
      pickerEndpoint: ENDPOINT,
      pickerQueryKey: ["scripts-picker"],
      optionState: (s) =>
        needsDeviceIds && !hasDeviceIds(s)
          ? { disabled: true, hint: "no device_ids" }
          : s.trusted
            ? { hint: "trusted" }
            : {},
      detailEndpoint: (id) => `${ENDPOINT}${id}/`,
      detailQueryKey: (id) => ["script", id],
      listEndpoint: ENDPOINT,
      searchHint: "Search name…",
      filters: [],
      columns: [
        { header: "Name", cell: (s) => s.name },
        {
          header: "Runs as",
          cell: (s) => (
            <span className="text-muted-foreground">{s.run_as}</span>
          ),
        },
        {
          header: "Owner",
          cell: (s) => (
            <span className="text-muted-foreground">{s.owner_name ?? "-"}</span>
          ),
        },
      ],
      rowState: (s) =>
        needsDeviceIds && !hasDeviceIds(s)
          ? { disabled: true, note: "no device_ids parameter" }
          : {},
    }),
    [needsDeviceIds]
  )
  return <ObjectPicker<Script, Script> spec={spec} label={label} {...rest} />
}
