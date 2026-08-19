import { useQuery } from "@tanstack/react-query"
import { ShieldAlert, ShieldX } from "lucide-react"

import { api, type CertificateAssignment, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  CERT_CRITICAL_DAYS,
  CERT_WARNING_DAYS,
} from "@/components/columns/certificate-columns"

// Worst expiry state across the certificates *declared* on an object, so a
// device/VM/IP can flag "a cert here is expiring" without opening the cert
// section. Client-side thresholds mirror the cert list (7/30); the authoritative
// alerting thresholds live server-side and drive the actual alerts/emails.
export type WorstExpiry = "expired" | "critical" | "warning" | null

const RANK: Record<Exclude<WorstExpiry, null>, number> = {
  warning: 1,
  critical: 2,
  expired: 3,
}

export function worstAssignmentExpiry(
  rows: Pick<CertificateAssignment, "certificate_not_after">[]
): WorstExpiry {
  let worst: WorstExpiry = null
  const now = Date.now()
  for (const r of rows) {
    if (!r.certificate_not_after) continue
    const days =
      (new Date(r.certificate_not_after).getTime() - now) / 86_400_000
    const s: WorstExpiry =
      days <= 0
        ? "expired"
        : days <= CERT_CRITICAL_DAYS
          ? "critical"
          : days <= CERT_WARNING_DAYS
            ? "warning"
            : null
    if (s && (!worst || RANK[s] > RANK[worst])) worst = s
  }
  return worst
}

const VARIANT: Record<
  Exclude<WorstExpiry, null>,
  "destructive" | "warning" | "info"
> = {
  expired: "destructive",
  critical: "warning",
  warning: "info",
}

const LABEL: Record<Exclude<WorstExpiry, null>, string> = {
  expired: "Cert expired",
  critical: "Cert expiring",
  warning: "Cert expiring",
}

/** The compact badge itself, given an already-computed worst state. */
export function CertExpiryBadge({ worst }: { worst: WorstExpiry }) {
  if (!worst) return null
  const Icon = worst === "expired" ? ShieldX : ShieldAlert
  return (
    <Badge variant={VARIANT[worst]} className="gap-1">
      <Icon className="h-3 w-3" />
      {LABEL[worst]}
    </Badge>
  )
}

/**
 * Fetches an object's certificate assignments (sharing the CertificatesPanel's
 * exact query key, so it hits cache rather than the network) and renders the
 * worst-expiry badge - nothing when every declared cert is healthy or none are
 * assigned. Lets the Overview banner warn without opening the cert section.
 */
export function ObjectCertExpiryBadge({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const q = useQuery({
    queryKey: ["certificate-assignments", objectType, objectId],
    queryFn: () =>
      api<Paginated<CertificateAssignment>>(
        `/api/monitoring/certificate-assignments/?${new URLSearchParams({
          object_type: objectType,
          object_id: objectId,
        }).toString()}`
      ),
  })
  return (
    <CertExpiryBadge worst={worstAssignmentExpiry(q.data?.results ?? [])} />
  )
}
