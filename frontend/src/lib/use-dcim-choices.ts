import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DcimChoice, DcimChoices } from "@/lib/api"

const EMPTY: DcimChoices = {
  interface_types: [],
  interface_duplex: [],
  interface_modes: [],
  lag_protocols: [],
  lacp_modes: [],
  lacp_rates: [],
  poe_modes: [],
  poe_types: [],
  cable_types: [],
  front_port_types: [],
  console_port_types: [],
  power_port_types: [],
  power_outlet_types: [],
  aux_port_types: [],
  antenna_types: [],
  antenna_bands: [],
  antenna_polarizations: [],
  rf_connector_types: [],
  feed_legs: [],
  airflow: [],
  cooling_method: [],
  cooling_capability: [],
  cooling_source_types: [],
  cooling_fluids: [],
  cooling_feed_types: [],
  connector_fibers: {},
  common_speeds: [],
}

/**
 * Interface/cable type dropdown options + speed suggestions, served from
 * `/api/dcim/choices/` (single source of truth - the long lists live in the
 * backend `dcim_choices.py`). Cached for the session; the lists are static.
 */
export function useDcimChoices(): DcimChoices {
  const q = useQuery({
    queryKey: ["dcim-choices"],
    queryFn: () => api<DcimChoices>("/api/dcim/choices/"),
    staleTime: 60 * 60_000,
  })
  // Every list present, even in an answer that lacks one: a form reads its
  // options straight off the result.
  return useMemo(() => (q.data ? { ...EMPTY, ...q.data } : EMPTY), [q.data])
}

/** A value's label in one of the lists ("Front to rear" for
 * `front-to-rear`); the value itself until the choices load, or for a value
 * the list does not know. */
export function choiceLabel(
  list: readonly DcimChoice[] | undefined,
  value: string
): string {
  return list?.find((c) => c.value === value)?.label ?? value
}

/** A cable type's label as the cable list shows it ("CAT6"), not its stored
 * value ("cat6"); the value itself until the choices load, or for a value
 * the list does not know. Keys (a hidden set, a fold) stay the value. */
export function useCableTypeLabel(): (value: string) => string {
  const choices = useDcimChoices()
  return (value) =>
    choices.cable_types.find((c) => c.value === value)?.label ?? value
}
