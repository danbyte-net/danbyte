import { FormSelect } from "@/components/forms"
import type { TopologyPhotoSize } from "@/lib/api"

/** A device's, type's or role's photo size on the topology Diagram: Inherit
 * (null), Rack width or Own size - one control for all three forms. */
export function TopologyPhotoSizeSelect({
  value,
  onChange,
  error,
  label = "Topology photo size",
}: {
  value: TopologyPhotoSize | null
  onChange: (next: TopologyPhotoSize | null) => void
  error?: string
  label?: string
}) {
  return (
    <FormSelect
      label={label}
      info="Device, then type, then role; rack width when none is set. Own size is the size saved in the photo editor, else the upload size."
      value={value}
      onChange={(v) => onChange(v === "rack" || v === "own" ? v : null)}
      noneLabel="Inherit"
      placeholder="Inherit"
      options={[
        { value: "rack", label: "Rack width" },
        { value: "own", label: "Own size" },
      ]}
      error={error}
    />
  )
}

/** The API's value as the select's: "" inherits. */
export const photoSizeOf = (
  v: string | null | undefined
): TopologyPhotoSize | null => (v === "rack" || v === "own" ? v : null)
