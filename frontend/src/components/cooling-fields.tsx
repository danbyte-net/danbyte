import { FormSelect, FormText } from "@/components/forms"
import { useDcimChoices } from "@/lib/use-dcim-choices"

/**
 * A rack's cooling (#434), on the rack form and the rack-type form: what its
 * cooling takes - the API's `cooling_capability` list - and the heat it
 * removes, entered in kW (the caller converts with `kwToWatts`). A refusal
 * on `cooling_capacity_w` shows under the kW field.
 */
export function CoolingFields({
  capability,
  onCapability,
  capacityKw,
  onCapacityKw,
  errors,
}: {
  capability: string | null
  onCapability: (v: string | null) => void
  capacityKw: string
  onCapacityKw: (v: string) => void
  errors: Record<string, string | undefined>
}) {
  const choices = useDcimChoices()
  return (
    <div className="grid gap-3 @md:grid-cols-2">
      <FormSelect
        label="Capability"
        info="Air, air and a liquid loop (hybrid), a liquid loop alone, or an immersion tank. Hardware it does not take is refused."
        value={capability}
        onChange={onCapability}
        noneLabel="Not recorded"
        placeholder="Not recorded"
        options={choices.cooling_capability}
        error={errors.cooling_capability}
      />
      <FormText
        label="Capacity (kW)"
        hint="optional"
        info="The heat the cooling removes. The racks' heat load is measured against it."
        type="number"
        inputMode="decimal"
        min={0}
        step={0.001}
        value={capacityKw}
        onChange={onCapacityKw}
        error={errors.cooling_capacity_w}
      />
    </div>
  )
}
