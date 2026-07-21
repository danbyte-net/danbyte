import { useRef } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import {
  usePlugins,
  useServices,
  type PluginInfo,
  type ServiceInfo,
} from "@/lib/plugins"
import { useMe } from "@/lib/use-me"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsSettingsPage,
})

function PluginsSettingsPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader title="Plugins & services">
        Installed plugins, per-tenant enablement, and control of the Danbyte
        background services. Restarting services is restricted to superusers.
      </SettingsHeader>
      <PluginsSection />
      <ServicesSection />
    </div>
  )
}

const STATE_VARIANT: Record<string, "secondary" | "destructive" | "outline"> = {
  loaded: "secondary",
  incompatible: "outline",
  error: "destructive",
  pending: "outline",
}

function PluginsSection() {
  const qc = useQueryClient()
  const { me } = useMe()
  const list = usePlugins()

  const toggle = useMutation({
    mutationFn: (v: { slug: string; enabled: boolean }) =>
      api(`/api/plugins/${v.slug}/config/`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: v.enabled, scope: "tenant" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugins-list"] })
      qc.invalidateQueries({ queryKey: ["plugin-ui"] })
      toast.success("Saved")
    },
    onError: (e) => apiErrorToast(e),
  })

  const apply = useMutation({
    mutationFn: () => api("/api/plugins/apply/", { method: "POST" }),
    onSuccess: () => toast.success("Applying — Danbyte will restart shortly."),
    onError: (e) => apiErrorToast(e),
  })

  const uninstall = useMutation({
    mutationFn: (module: string) =>
      api(`/api/plugins/${module}/uploaded/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugins-list"] })
      toast.success("Removed — Apply changes to finish.")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!list.data) return null
  const plugins = list.data.plugins
  // Show the Apply prompt for unapplied migrations OR an uploaded plugin that
  // isn't loaded yet (needs a restart).
  const pending = list.data.needs_apply ?? list.data.has_pending_migrations

  return (
    <SettingsCard
      title="Installed plugins"
      description={
        <>
          Plugins install as Python packages (pip, or upload an archive below
          for offline installs) and apply on restart. Enable or disable each one
          for this tenant. Blank list = none installed.
        </>
      }
    >
      {me.is_superuser && <UploadPlugin qc={qc} />}
      {pending && me.is_superuser && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span>
            {list.data.has_pending_migrations
              ? "Plugin changes are pending (database migrations + restart)."
              : "An uploaded plugin needs a restart to load."}
          </span>
          <ConfirmButton
            label="Apply changes"
            pendingLabel="Applying…"
            title="Apply plugin changes?"
            body="This runs database migrations and restarts Danbyte. Active users will briefly lose connectivity."
            onConfirm={() => apply.mutate()}
            disabled={apply.isPending}
          />
        </div>
      )}
      {plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plugins installed.</p>
      ) : (
        <div className="divide-y rounded-lg border border-border">
          {plugins.map((p) => (
            <PluginRow
              key={p.module}
              plugin={p}
              canManage={!!me.is_superuser}
              onToggle={(enabled) => toggle.mutate({ slug: p.slug, enabled })}
              onUninstall={() => uninstall.mutate(p.module)}
              busy={toggle.isPending || uninstall.isPending}
            />
          ))}
        </div>
      )}
    </SettingsCard>
  )
}

function UploadPlugin({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData()
      body.append("archive", file)
      return api<{ installed: string }>("/api/plugins/upload/", {
        method: "POST",
        body,
      })
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["plugins-list"] })
      toast.success(`Installed '${d.installed}'. Apply changes to activate.`)
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">
        Offline install: upload a plugin archive (.tar.gz / .zip). Runs its code
        on restart — superuser only.
      </span>
      <input
        ref={inputRef}
        type="file"
        accept=".tar.gz,.tgz,.tar,.zip,application/gzip,application/zip,application/x-tar"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void upload.mutate(f)
          e.target.value = ""
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={upload.isPending}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-3.5 w-3.5" />
        {upload.isPending ? "Uploading…" : "Upload plugin"}
      </Button>
    </div>
  )
}

function PluginRow({
  plugin,
  canManage,
  onToggle,
  onUninstall,
  busy,
}: {
  plugin: PluginInfo
  canManage: boolean
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  busy: boolean
}) {
  const loaded = plugin.state === "loaded"
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{plugin.name}</span>
          <Badge variant={STATE_VARIANT[plugin.state] ?? "outline"}>
            {plugin.state}
          </Badge>
          {plugin.uploaded && (
            <Badge variant="outline" className="text-[10px]">
              uploaded
            </Badge>
          )}
          {plugin.version && (
            <span className="text-[11px] text-muted-foreground">
              v{plugin.version}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground">
          {plugin.error || plugin.description || plugin.module}
        </div>
        {plugin.unapplied_migrations.length > 0 && (
          <div className="text-[11px] text-amber-600 dark:text-amber-500">
            {plugin.unapplied_migrations.length} unapplied migration(s)
          </div>
        )}
      </div>
      {canManage && plugin.uploaded && (
        <ConfirmButton
          label="Uninstall"
          pendingLabel="Removing…"
          title={`Uninstall ${plugin.name}?`}
          body="Removes the uploaded plugin files and manifest entry. Takes effect after Apply changes (restart)."
          onConfirm={onUninstall}
          disabled={busy}
          small
        />
      )}
      {loaded && (
        <Switch
          defaultChecked
          disabled={busy}
          onCheckedChange={(v) => onToggle(v)}
          aria-label={`Enable ${plugin.name}`}
        />
      )}
    </div>
  )
}

function ServicesSection() {
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
          onConfirm={() => restart.mutate("/api/services/restart-all/")}
          disabled={restart.isPending}
          icon
        />
      </div>
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
                restart.mutate(`/api/services/${s.key}/restart/`)
              }
              disabled={restart.isPending}
            />
          ))}
        </div>
      )}
    </SettingsCard>
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
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{service.label}</div>
        <div className="text-[11px] text-muted-foreground">{service.unit}</div>
      </div>
      <Badge variant={ok ? "secondary" : "destructive"}>{service.state}</Badge>
      <ConfirmButton
        label="Restart"
        pendingLabel="Restarting…"
        title={`Restart ${service.label}?`}
        body="This restarts the service; requests it handles will briefly fail."
        onConfirm={onRestart}
        disabled={disabled}
        small
      />
    </div>
  )
}

function ConfirmButton({
  label,
  pendingLabel,
  title,
  body,
  onConfirm,
  disabled,
  small,
  icon,
}: {
  label: string
  pendingLabel: string
  title: string
  body: string
  onConfirm: () => void
  disabled?: boolean
  small?: boolean
  icon?: boolean
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={small ? "h-7 px-2 text-xs" : undefined}
        >
          {icon && <RefreshCw className="h-3.5 w-3.5" />}
          {disabled ? pendingLabel : label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
