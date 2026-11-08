import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import type { PrtgGroups } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { FormCombobox } from "@/components/forms"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Whether the tenant has the PRTG integration on. Shares the sidebar's
 * cached toggle list. */
export function usePrtgEnabled(): boolean {
  const toggles = useQuery({
    queryKey: ["integrations-enabled"],
    queryFn: () => api<Record<string, boolean>>("/api/integrations/enabled/"),
    staleTime: 5 * 60_000,
  })
  return !!toggles.data?.prtg
}

/**
 * Pick the PRTG probe or group new devices go under. The list is what the
 * server kept from its last read of PRTG; the refresh button asks PRTG again.
 * Stores the object id and the path it had when picked.
 */
export function PrtgGroupPicker({
  connectionId,
  value,
  path,
  onChange,
  label = "PRTG group",
  error,
  required,
}: {
  connectionId: string
  value: string | null
  /** The stored path, so a group PRTG no longer lists still reads. */
  path?: string
  onChange: (objid: string | null, path: string) => void
  label?: string
  error?: string
  required?: boolean
}) {
  const qc = useQueryClient()
  const groups = useQuery({
    queryKey: ["prtg-groups", connectionId],
    queryFn: () =>
      api<PrtgGroups>(`/api/prtg/groups/?connection=${connectionId}`),
    staleTime: 60_000,
  })
  const refresh = async () => {
    const fresh = await api<PrtgGroups>(
      `/api/prtg/groups/?connection=${connectionId}&refresh=1`
    )
    qc.setQueryData(["prtg-groups", connectionId], fresh)
  }
  const rows = useMemo(() => groups.data?.groups ?? [], [groups.data])
  const options = useMemo(() => {
    const out = rows.map((g) => ({
      value: g.objid,
      label: g.path,
      group: g.kind === "probe" ? "Probes" : "Groups",
    }))
    if (value && !rows.some((g) => g.objid === value))
      out.unshift({ value, label: path || value, group: "Not in PRTG" })
    return out
  }, [rows, value, path])

  return (
    <FormCombobox
      label={label}
      required={required}
      hint={groups.data?.error ? "PRTG unreachable" : undefined}
      value={value}
      onChange={(v) =>
        onChange(v, v ? (rows.find((g) => g.objid === v)?.path ?? "") : "")
      }
      options={options}
      searchPlaceholder="Search groups…"
      emptyText={groups.isLoading ? "Loading…" : "No groups."}
      error={error}
      quickAdd={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Read groups from PRTG"
              onClick={() => void refresh()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent variant="panel">Read groups from PRTG</TooltipContent>
        </Tooltip>
      }
    />
  )
}
