import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { DcimChoices } from "@/lib/api"

const EMPTY: DcimChoices = {
  interface_types: [],
  interface_duplex: [],
  interface_modes: [],
  poe_modes: [],
  poe_types: [],
  cable_types: [],
  front_port_types: [],
  console_port_types: [],
  power_port_types: [],
  power_outlet_types: [],
  aux_port_types: [],
  feed_legs: [],
  connector_fibers: {},
  common_speeds: [],
}

/**
 * Interface/cable type dropdown options + speed suggestions, served from
 * `/api/dcim/choices/` (single source of truth — the long lists live in the
 * backend `dcim_choices.py`). Cached for the session; the lists are static.
 */
export function useDcimChoices(): DcimChoices {
  const q = useQuery({
    queryKey: ["dcim-choices"],
    queryFn: () => api<DcimChoices>("/api/dcim/choices/"),
    staleTime: 60 * 60_000,
  })
  return q.data ?? EMPTY
}
