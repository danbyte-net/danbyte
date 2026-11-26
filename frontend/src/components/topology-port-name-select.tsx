import { FormSelect } from "@/components/forms"
import type { TopologyPortName } from "@/lib/api"
import { portNameModeOf } from "@/components/topology/port-names"

/** A device's own choice of what the topology prints its ports by (#541):
 * Inherit (the map's Display choice), Name, Label or Description. */
export function TopologyPortNameSelect({
  value,
  onChange,
  error,
  label = "Port names",
}: {
  value: TopologyPortName | null
  onChange: (next: TopologyPortName | null) => void
  error?: string
  label?: string
}) {
  return (
    <FormSelect
      label={label}
      info="Device, then the map's choice. A port without the field shows its name."
      value={value}
      onChange={(v) => onChange(portNameModeOf(v) ?? null)}
      noneLabel="Inherit"
      placeholder="Inherit"
      options={[
        { value: "name", label: "Name" },
        { value: "label", label: "Label" },
        { value: "description", label: "Description" },
      ]}
      error={error}
    />
  )
}

/** The API's value as the select's: "" inherits. */
export const portNameOf = (
  v: string | null | undefined
): TopologyPortName | null => portNameModeOf(v) ?? null
