import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, formatBytes } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SettingsCard } from "@/components/settings/settings-card"
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SimpleTable } from "@/components/ui/simple-table"
import { Field } from "@/components/forms/field"

interface HousekeepingRow {
  label: string
  count: number
  bytes: number
}
interface HousekeepingTotal {
  label: string
  path: string
  bytes: number
}
interface HousekeepingReport {
  stale: HousekeepingRow[]
  stale_bytes: number
  totals: HousekeepingTotal[]
  freed_bytes?: number
}

/** What Danbyte leaves on disk - old rollback archives, surplus
 * before-upgrade backups, wheels from earlier releases, rotated logs - and
 * how much of it to keep. Cleaned nightly and after every upgrade; the
 * button does it now. */
export function HousekeepingCard() {
  const qc = useQueryClient()
  const { data, save, savingKey } = useDeploymentSettings()
  const [keep, setKeep] = useState<string | null>(null)
  const [days, setDays] = useState<string | null>(null)

  useEffect(() => {
    if (data) {
      setKeep(String(data.upgrade_backups_keep))
      setDays(String(data.log_retention_days))
    }
  }, [data])

  const report = useQuery({
    queryKey: ["housekeeping"],
    queryFn: () => api<HousekeepingReport>("/api/backups/housekeeping/"),
  })
  const run = useMutation({
    mutationFn: () =>
      api<HousekeepingReport>("/api/backups/housekeeping/", {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      qc.setQueryData(["housekeeping"], r)
      qc.invalidateQueries({ queryKey: ["backups"] })
      toast.success(`Freed ${formatBytes(r.freed_bytes ?? 0)}`)
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!data) return null
  const rows = (report.data?.stale ?? []).filter((r) => r.count > 0)
  return (
    <SettingsCard
      title="Housekeeping"
      description="Upgrade leftovers and old logs. Cleaned every night and after each upgrade."
      onSave={() =>
        save.mutate({
          key: "housekeeping",
          patch: {
            upgrade_backups_keep: Math.max(1, Number(keep) || 1),
            log_retention_days: Math.max(0, Number(days) || 0),
          },
        })
      }
      dirty={
        keep !== String(data.upgrade_backups_keep) ||
        days !== String(data.log_retention_days)
      }
      saving={savingKey === "housekeeping"}
      saveLabel="Save housekeeping"
    >
      <Field
        label="Upgrade backups kept"
        hint="Before-upgrade backups and code rollback archives, newest first."
      >
        <Input
          type="number"
          min={1}
          value={keep ?? ""}
          onChange={(e) => setKeep(e.target.value)}
          className="w-40"
        />
      </Field>
      <Field
        label="Rotated logs kept (days)"
        hint="Older rotated log files are deleted. 0 = keep forever."
      >
        <Input
          type="number"
          min={0}
          value={days ?? ""}
          onChange={(e) => setDays(e.target.value)}
          className="w-40"
        />
      </Field>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">
            {report.isLoading
              ? "Loading..."
              : rows.length
                ? `${formatBytes(report.data?.stale_bytes ?? 0)} can be freed`
                : "Nothing stale."}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending || rows.length === 0}
            onClick={() => run.mutate()}
          >
            {run.isPending ? "Cleaning up..." : "Clean up now"}
          </Button>
        </div>
        {rows.length > 0 && (
          <SimpleTable
            columns={[
              { id: "label", header: "What", flex: true, cell: (r) => r.label },
              {
                id: "count",
                header: "Items",
                cell: (r) => <span className="num">{r.count}</span>,
              },
              {
                id: "bytes",
                header: "Size",
                cell: (r) => (
                  <span className="num">{formatBytes(r.bytes)}</span>
                ),
              },
            ]}
            data={rows}
            getRowKey={(r) => r.label}
          />
        )}
        {report.data && (
          <SimpleTable
            columns={[
              { id: "label", header: "Folder", cell: (r) => r.label },
              {
                id: "path",
                header: "Path",
                flex: true,
                cell: (r) => (
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.path || "-"}
                  </span>
                ),
              },
              {
                id: "bytes",
                header: "Size",
                cell: (r) => (
                  <span className="num">{formatBytes(r.bytes)}</span>
                ),
              },
            ]}
            data={report.data.totals}
            getRowKey={(r) => r.label}
          />
        )}
      </div>
    </SettingsCard>
  )
}
