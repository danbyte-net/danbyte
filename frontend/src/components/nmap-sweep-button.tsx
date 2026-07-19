import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ScanSearch } from "lucide-react"

import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * Run an nmap ping-sweep over a prefix and seed any live hosts as discovered
 * IPs (#84, Phase 4). Fails cleanly (a toast) when nmap isn't installed.
 */
export function NmapSweepButton({ prefixId }: { prefixId: string }) {
  const qc = useQueryClient()
  const sweep = useMutation({
    mutationFn: () =>
      api<{ found: number; created: number }>(
        `/api/monitoring/prefixes/${prefixId}/nmap-sweep/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(
        `nmap: ${r.found} live host${r.found === 1 ? "" : "s"}, ` +
          `${r.created} new IP${r.created === 1 ? "" : "s"} added`
      )
      qc.invalidateQueries({ queryKey: ["prefix-ips", prefixId] })
      qc.invalidateQueries({ queryKey: ["ips"] })
      // Newly-seeded IPs change the prefix's utilisation stat and its visual
      // space map, both keyed on the prefix id — refresh them too.
      qc.invalidateQueries({ queryKey: ["prefix", prefixId] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map", prefixId] })
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={sweep.isPending}
      onClick={() => sweep.mutate()}
    >
      {sweep.isPending ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        <ScanSearch className="h-3.5 w-3.5" />
      )}
      Scan (nmap)
    </Button>
  )
}
