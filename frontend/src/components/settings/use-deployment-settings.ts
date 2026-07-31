import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DeploymentSettings } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * Shared access to the single deployment-settings object for the split
 * deployment pages (General, Security, Sites, Maps, …). Every page reads the
 * same cached `["deployment-email"]` query (one fetch) and writes through the
 * same per-card mutation: `save.mutate({ key, patch })` sends `{...server data,
 * ...patch}`, so saving one card never persists another page's unsaved edits,
 * and `savingKey` drives the per-card "Saving…" state.
 */
export function useDeploymentSettings() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ["deployment-email"],
    queryFn: () => api<DeploymentSettings>("/api/deployment/email/"),
  })
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (v: { key: string; patch: Partial<DeploymentSettings> }) =>
      api<DeploymentSettings>("/api/deployment/email/", {
        method: "PUT",
        body: JSON.stringify({ ...data, ...v.patch }),
      }),
    onMutate: (v) => setSavingKey(v.key),
    onSettled: () => setSavingKey(null),
    onSuccess: (d) => {
      qc.setQueryData(["deployment-email"], d)
      qc.invalidateQueries({ queryKey: ["me"] })
      toast.success("Saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  return { data, save, savingKey }
}
