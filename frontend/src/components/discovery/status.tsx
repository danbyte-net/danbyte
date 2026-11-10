import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  DiscoveryStatus,
  InventoryHostStatus,
  InventoryRunStatus,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"

// Built-in discovery (#451 B2): the run and per-host status pills, one
// variant per status, shared by every table and page that shows them.

type Variant = "secondary" | "info" | "success" | "warning" | "destructive"

export const RUN_STATUS_LABELS: Record<InventoryRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  ok: "OK",
  partial: "Partial",
  failed: "Failed",
  skipped: "Skipped",
}

const RUN_VARIANT: Record<InventoryRunStatus, Variant> = {
  queued: "secondary",
  running: "info",
  ok: "success",
  partial: "warning",
  failed: "destructive",
  skipped: "secondary",
}

export const HOST_STATUS_LABELS: Record<InventoryHostStatus | "ready", string> =
  {
    ready: "Ready",
    ok: "OK",
    auth_failed: "Login refused",
    host_key_refused: "Host key not accepted",
    unreachable: "Unreachable",
    timeout: "Timed out",
    unsupported: "Unsupported",
    failed: "Failed",
    no_credential: "No SSH credential",
    no_address: "No address",
    exempt: "Exempt",
    denied: "Deny subnet",
    maintenance: "In maintenance",
    blocked: "Blocked target",
  }

const HOST_VARIANT: Record<InventoryHostStatus | "ready", Variant> = {
  ready: "info",
  ok: "success",
  auth_failed: "destructive",
  host_key_refused: "warning",
  unreachable: "destructive",
  timeout: "destructive",
  unsupported: "secondary",
  failed: "destructive",
  no_credential: "warning",
  no_address: "secondary",
  exempt: "secondary",
  denied: "secondary",
  maintenance: "secondary",
  blocked: "warning",
}

export function isRunActive(s: InventoryRunStatus): boolean {
  return s === "queued" || s === "running"
}

export function RunStatusBadge({ status }: { status: InventoryRunStatus }) {
  return (
    <Badge variant={RUN_VARIANT[status]}>{RUN_STATUS_LABELS[status]}</Badge>
  )
}

export function HostStatusBadge({
  status,
}: {
  status: InventoryHostStatus | "ready"
}) {
  return (
    <Badge variant={HOST_VARIANT[status]} className="whitespace-nowrap">
      {HOST_STATUS_LABELS[status]}
    </Badge>
  )
}

/** The two switches. Shared key so the integrations card, the nav and the
 *  host tabs read one answer. */
export function useDiscoveryStatus(enabled = true) {
  return useQuery({
    queryKey: ["discovery", "status"],
    queryFn: () => api<DiscoveryStatus>("/api/discovery/status/"),
    enabled,
    staleTime: 60_000,
  })
}
