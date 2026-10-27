import { toast } from "sonner"

import type { PrtgDeleteResult } from "@/lib/api"

/** Toast what PRTG did: failures as errors, a queued job as a note. */
export function prtgDeleteToast(results: PrtgDeleteResult[] | undefined) {
  const rows = results ?? []
  const failed = rows.filter((r) => !r.ok)
  const queued = rows.filter((r) => r.ok && r.queued)
  if (failed.length)
    toast.error(
      `PRTG: ${failed.map((r) => `${r.name} - ${r.detail}`).join("; ")}`
    )
  if (queued.length)
    toast.message(
      `PRTG is slow; ${queued.length} PRTG device${
        queued.length === 1 ? "" : "s"
      } will follow shortly.`
    )
}
