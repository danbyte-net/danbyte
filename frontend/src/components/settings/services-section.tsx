import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Cpu } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useServices } from "@/lib/plugins"
import type { ServiceInfo, WorkerConfig } from "@/lib/plugins"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SettingsCard } from "@/components/settings/settings-card"
import { ConfirmButton } from "@/components/settings/plugins-section"

/**
 * Restart Danbyte or one of its background services, and size the worker pool.
 *
 * Lives with the rest of "this install" rather than beside the plugin
 * switches: restarting a service is not something you turn on, and the page
 * that answers "what is switched on here?" should hold only switches.
 */

export function ServicesSection() {
  const { me } = useMe()
  const qc = useQueryClient()
  const services = useServices(!!me.is_superuser)

  const restart = useMutation({
    mutationFn: (path: string) => api(path, { method: "POST" }),
    onSuccess: () => {
      toast.success("Restart scheduled.")
      setTimeout(() => qc.invalidateQueries({ queryKey: ["services"] }), 4000)
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!me.is_superuser) {
    return (
      <SettingsCard title="Services">
        <p className="text-sm text-muted-foreground">
          Only superusers can view or restart services.
        </p>
      </SettingsCard>
    )
  }

  const rows = services.data?.services ?? []

  return (
    <SettingsCard
      title="Services"
      description="Restart Danbyte or an individual background service. The database is never affected."
    >
      <div className="mb-3">
        <ConfirmButton
          label="Restart Danbyte"
          pendingLabel="Restarting…"
          title="Restart Danbyte?"
          body="This restarts the core Danbyte services (web, workers, websocket). Active users will briefly lose connectivity."
          onConfirm={() => restart.mutate("/api/system/services/restart-all/")}
          disabled={restart.isPending}
          destructive
          icon
        />
      </div>

      {services.data?.workers && (
        <WorkersControl workers={services.data.workers} />
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No manageable services detected in this environment.
        </p>
      ) : (
        <div className="divide-y rounded-lg border border-border">
          {rows.map((s) => (
            <ServiceRow
              key={s.key}
              service={s}
              onRestart={() =>
                restart.mutate(`/api/system/services/${s.key}/restart/`)
              }
              disabled={restart.isPending}
            />
          ))}
        </div>
      )}
    </SettingsCard>
  )
}

function WorkersControl({ workers }: { workers: WorkerConfig }) {
  const qc = useQueryClient()
  const [count, setCount] = useState(String(workers.rq_workers))

  const apply = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; detail?: string; rq_workers?: number }>(
        "/api/system/services/workers/",
        { method: "POST", body: JSON.stringify({ count: Number(count) }) }
      ),
    onSuccess: (r) => {
      toast.success(
        r.ok
          ? `Worker pool set to ${r.rq_workers} - restarting…`
          : (r.detail ?? "Saved.")
      )
      setTimeout(() => qc.invalidateQueries({ queryKey: ["services"] }), 4000)
    },
    onError: (e) => apiErrorToast(e),
  })

  const n = Number(count)
  const dirty = n !== workers.rq_workers
  const valid = Number.isInteger(n) && n >= workers.min && n <= workers.max

  return (
    <div className="mb-3 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <Cpu className="size-4 text-muted-foreground" />
        Background workers (RQ pool)
      </div>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        How many worker processes run jobs in parallel - more workers clear
        queued scans/imports faster (uses more RAM/CPU). Applying restarts the
        worker pool; other services are untouched.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Input
          type="number"
          min={workers.min}
          max={workers.max}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          className="w-24"
        />
        <Button
          size="sm"
          onClick={() => apply.mutate()}
          disabled={!dirty || !valid || apply.isPending}
        >
          {apply.isPending ? "Applying…" : "Apply"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {workers.min}–{workers.max}
          {!workers.managed && " · not managed in this environment"}
        </span>
      </div>
    </div>
  )
}

function ServiceRow({
  service,
  onRestart,
  disabled,
}: {
  service: ServiceInfo
  onRestart: () => void
  disabled: boolean
}) {
  const ok = service.state === "active"
  // Installed but neither running nor enabled: this install does not use
  // it (the dev box links gunicorn, the prod box the runserver). Not a
  // fault, and nothing to restart.
  const unused = !service.in_use
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div
          className={
            unused ? "font-medium text-muted-foreground" : "font-medium"
          }
        >
          {service.label}
        </div>
        <div className="text-[11px] text-muted-foreground">{service.unit}</div>
      </div>
      {unused ? (
        <Badge variant="outline" className="text-muted-foreground">
          not in use here
        </Badge>
      ) : (
        <Badge
          variant={
            ok
              ? "secondary"
              : service.state === "failed"
                ? "destructive"
                : "warning"
          }
        >
          {service.state}
        </Badge>
      )}
      {!unused && (
        <ConfirmButton
          label="Restart"
          pendingLabel="Restarting…"
          title={`Restart ${service.label}?`}
          body="This restarts the service; requests it handles will briefly fail."
          onConfirm={onRestart}
          disabled={disabled}
          small
        />
      )}
    </div>
  )
}
