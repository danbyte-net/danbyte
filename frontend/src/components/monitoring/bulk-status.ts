import { api } from "@/lib/api"
import type { BulkStatusEntry, BulkStatusResponse } from "@/lib/api"
import { batches } from "@/lib/batches"

/** Ids one status call takes: the server's bound for prefixes on
 * `/api/monitoring/status/` and for every kind on `/api/monitoring/sla-status/`. */
export const STATUS_BATCH = 5000

/** The monitoring roll-up for every prefix id, however many: one POST per
 * batch, answers merged (#430). A list over the server's bound used to get a
 * 400 and show every row as not monitored. */
export async function fetchPrefixStatuses(
  ids: string[]
): Promise<BulkStatusResponse> {
  const answers = await Promise.all(
    batches(ids, STATUS_BATCH).map((part) =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ prefixes: part }),
      })
    )
  )
  const statuses: Record<string, BulkStatusEntry> = {}
  for (const a of answers) Object.assign(statuses, a.statuses)
  return { statuses }
}
