import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { ObjectPerms, ScanExemptManyResult } from "@/lib/api"
import { objCan, useMe } from "@/lib/use-me"
import { FormCheckbox } from "@/components/forms"
import { useDiscoveryStatus } from "@/components/discovery/status"

// "Do not scan" (#451): an object's scan_exempt flag on its edit form. The
// serializers return the flag read-only; the draft writes it through
// POST /api/discovery/exempt/ after the form saved (change-logged, RBAC and
// site rules as the object's change).

export type ScanExemptKind =
  "device" | "virtual_machine" | "ipaddress" | "prefix"

const SLUG: Record<ScanExemptKind, string> = {
  device: "device",
  virtual_machine: "virtualmachine",
  ipaddress: "ipaddress",
  prefix: "prefix",
}

const QUERY_KEYS: Record<ScanExemptKind, string> = {
  device: "device",
  virtual_machine: "virtual-machine",
  ipaddress: "ip",
  prefix: "prefix",
}

export interface ScanExemptObject {
  id: string
  scan_exempt?: boolean
  permissions?: ObjectPerms
}

export function setScanExempt(
  kind: ScanExemptKind,
  id: string,
  exempt: boolean
): Promise<{ kind: string; id: string; scan_exempt: boolean }> {
  return api("/api/discovery/exempt/", {
    method: "POST",
    body: JSON.stringify({ kind, id, exempt }),
  })
}

/** Objects per call: `EXEMPT_MAX` in discovery/api.py. */
export const EXEMPT_PER_CALL = 500

/** Set the flag on many objects in one call (at most EXEMPT_PER_CALL).
 * Objects the caller may not change, or that are gone, count as
 * `not_found`; the rest are set. */
export function setScanExemptMany(
  objects: { kind: ScanExemptKind; id: string }[],
  exempt: boolean
): Promise<ScanExemptManyResult> {
  return api("/api/discovery/exempt/", {
    method: "POST",
    body: JSON.stringify({ objects, exempt }),
  })
}

/** The flag as a form draft: shown only for a saved object, while Discovery
 * is on for the tenant, to a user who may change the object. */
export function useScanExemptDraft(
  kind: ScanExemptKind,
  obj: ScanExemptObject | null | undefined
) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const status = useDiscoveryStatus(!!obj)
  const initial = !!obj?.scan_exempt
  const [draft, setDraft] = useState<boolean | null>(null)
  const value = draft ?? initial
  const show =
    !!obj &&
    !!status.data?.active &&
    objCan(obj, "change", canDo(SLUG[kind], "change"))
  return {
    show,
    value,
    setValue: setDraft,
    /** Write the draft; a no-op when nothing changed. */
    commit: async () => {
      if (!show || draft === null || draft === initial) return
      await setScanExempt(kind, obj.id, draft)
      qc.invalidateQueries({ queryKey: [QUERY_KEYS[kind], obj.id] })
    },
  }
}

export type ScanExemptDraft = ReturnType<typeof useScanExemptDraft>

/** The checkbox, plus the prefix an address is exempt through. */
export function ScanExemptField({
  draft,
  via,
}: {
  draft: ScanExemptDraft
  via?: { id: string | null; cidr: string | null } | null
}) {
  if (!draft.show) return null
  return (
    <div className="flex flex-col gap-1">
      <FormCheckbox
        label="Do not scan"
        checked={draft.value}
        onChange={draft.setValue}
        info="Built-in discovery never contacts it, whatever a profile's scope says. A prefix covers every address inside it."
      />
      {via && <ExemptThrough via={via} />}
    </div>
  )
}

/** "Exempt through 10.0.0.0/24", read-only: changed on the prefix. */
export function ExemptThrough({
  via,
}: {
  via: { id: string | null; cidr: string | null }
}) {
  return (
    <span className="text-xs text-muted-foreground">
      Exempt through{" "}
      {via.id && via.cidr ? (
        <Link
          to="/prefixes/$id"
          params={{ id: via.id }}
          className="font-mono text-foreground hover:underline"
        >
          {via.cidr}
        </Link>
      ) : (
        "a prefix"
      )}
    </span>
  )
}
