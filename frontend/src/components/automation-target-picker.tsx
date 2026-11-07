import { useMemo } from "react"

import type { AutomationTarget } from "@/lib/api"
import { ObjectPicker } from "@/components/object-picker"
import type {
  ObjectPickerProps,
  ObjectPickerSpec,
} from "@/components/object-picker"
import { Badge } from "@/components/ui/badge"

export interface AutomationTargetPickerProps extends Omit<
  ObjectPickerProps,
  "label"
> {
  label?: string
}

const ENDPOINT = "/api/automation-targets/"

/** The automation-target preset of ObjectPicker - the active tenant's
 * targets. A disabled target stays pickable but says so. */
export function AutomationTargetPicker({
  label = "Target",
  ...rest
}: AutomationTargetPickerProps) {
  const spec = useMemo<ObjectPickerSpec<AutomationTarget, AutomationTarget>>(
    () => ({
      noun: "target",
      pickerEndpoint: ENDPOINT,
      pickerQueryKey: ["automation-targets-picker"],
      optionLabel: (t) => `${t.name} · ${t.kind_display}`,
      optionState: (t) => (t.enabled ? {} : { hint: "disabled" }),
      detailEndpoint: (id) => `${ENDPOINT}${id}/`,
      detailQueryKey: (id) => ["automation-target", id],
      detailLabel: (t) => `${t.name} · ${t.kind_display}`,
      listEndpoint: ENDPOINT,
      searchHint: "Search name or URL…",
      filters: [],
      columns: [
        { header: "Name", cell: (t) => t.name },
        {
          header: "Kind",
          cell: (t) => (
            <Badge variant="outline" className="text-[10px]">
              {t.kind_display}
            </Badge>
          ),
        },
        {
          header: "Runs",
          cell: (t) => (
            <span className="font-mono text-[11px] text-muted-foreground">
              {t.kind === "script" ? t.script_name : t.base_url}
            </span>
          ),
        },
      ],
    }),
    []
  )
  return (
    <ObjectPicker<AutomationTarget, AutomationTarget>
      spec={spec}
      label={label}
      {...rest}
    />
  )
}
