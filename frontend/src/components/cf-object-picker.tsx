import { useMemo } from "react"

import type { ReferenceModelMeta } from "@/lib/custom-fields"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { ObjectPicker, type ObjectPickerSpec } from "@/components/object-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { RackPicker } from "@/components/rack-picker"
import { VlanPicker } from "@/components/vlan-picker"

export interface CfObjectPickerProps {
  refMeta: ReferenceModelMeta
  label: string
  hint?: string
  value: string | null
  onChange: (v: string | null) => void
  customFieldId?: string
}

type AnyRow = { id: string } & Record<string, unknown>

/**
 * Value picker for an object-reference custom field. Models with a dedicated
 * advanced picker get it (devices, racks, VLANs, prefixes, IPs — full filter
 * modal); everything else — users, groups, plugin models — gets a generic
 * ObjectPicker built from the backend registry's metadata, so new reference
 * models need zero frontend changes.
 */
export function CfObjectPicker({
  refMeta,
  label,
  hint,
  value,
  onChange,
  customFieldId,
}: CfObjectPickerProps) {
  const common = { label, hint, value, onChange, noneLabel: "—", customFieldId }
  switch (refMeta.value) {
    case "device":
      return <DevicePicker {...common} />
    case "rack":
      return <RackPicker {...common} />
    case "vlan":
      return <VlanPicker {...common} />
    case "prefix":
      return <PrefixPicker {...common} />
    case "ipaddress":
      return <IpPicker {...common} />
    default:
      return <GenericRefPicker refMeta={refMeta} {...common} />
  }
}

function GenericRefPicker({
  refMeta,
  ...rest
}: CfObjectPickerProps & { noneLabel: string }) {
  const spec = useMemo<ObjectPickerSpec<AnyRow, AnyRow>>(() => {
    const labelOf = (o: AnyRow) =>
      String(o[refMeta.label_field] ?? (o as { name?: string }).name ?? o.id)
    const noun = refMeta.label.replace(/s$/i, "").toLowerCase()
    return {
      noun,
      pickerEndpoint: refMeta.picker
        ? `${refMeta.endpoint}?picker=1`
        : refMeta.endpoint,
      pickerQueryKey: ["cf-ref-picker", refMeta.value],
      optionLabel: labelOf,
      detailEndpoint: (id) => `${refMeta.endpoint}${id}/`,
      detailQueryKey: (id) => ["cf-ref", refMeta.value, id],
      detailLabel: labelOf,
      listEndpoint: refMeta.endpoint,
      searchHint: `Search ${refMeta.label.toLowerCase()}…`,
      filters: [],
      columns: [{ header: refMeta.label, cell: labelOf }],
    }
  }, [refMeta])
  return <ObjectPicker<AnyRow, AnyRow> spec={spec} {...rest} />
}
