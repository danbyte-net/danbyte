import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"

export interface UserPrefsResponse {
  values: Record<string, unknown>
  defaults: Record<string, unknown>
  user_set: string[]
}

// User display preferences, backed by /api/me/prefs/ (auth_api.user_prefs).
export function useUserPrefs() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["user-prefs"],
    queryFn: () => api<UserPrefsResponse>("/api/me/prefs/"),
    staleTime: 60_000,
  })
  const m = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<UserPrefsResponse>("/api/me/prefs/", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["user-prefs"], data)
      // /api/me/ carries values RESOLVED from prefs (me.datetime) — refresh it
      // so formatting picks the change up without a reload.
      qc.invalidateQueries({ queryKey: ["me"] })
    },
  })
  return {
    values: q.data?.values ?? {},
    isLoading: q.isLoading,
    saving: m.isPending,
    setPref: (key: string, value: unknown) => m.mutate({ [key]: value }),
  }
}
