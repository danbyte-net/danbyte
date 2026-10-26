import type { PrtgSync } from "@/lib/api"
import { FormSelect } from "@/components/forms"

export const PRTG_SYNC_OPTIONS: { value: PrtgSync; label: string }[] = [
  { value: "inherit", label: "Follow policies" },
  { value: "always", label: "Monitor in PRTG" },
  { value: "never", label: "Exclude from PRTG" },
]

/** Whether PRTG should have this device or VM: the policies decide, or the
 * object overrules them either way. */
export function PrtgSyncSelect({
  value,
  onChange,
  error,
}: {
  value: PrtgSync
  onChange: (v: PrtgSync) => void
  error?: string
}) {
  return (
    <FormSelect
      label="PRTG"
      info="Follow policies lets the PRTG policies and Register all decide. Monitor in PRTG plans it whatever they say; Exclude from PRTG keeps it out of every plan."
      value={value}
      onChange={(v) => onChange((v ?? "inherit") as PrtgSync)}
      options={PRTG_SYNC_OPTIONS}
      error={error}
    />
  )
}
