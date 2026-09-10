import { useRef } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { RefreshCw, Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { usePlugins } from "@/lib/plugins"
import type { PluginInfo } from "@/lib/plugins"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { cardAnchor } from "@/components/settings/settings-card"
import {
  ToggleCard,
  ToggleCardGrid,
} from "@/components/settings/toggle-card"

/**
 * Installed plugins, as switchable cards on the Integrations page.
 *
 * They were their own settings page, which split "what is switched on here?"
 * across two places - and the answer is the same kind of answer either way.
 * Installing and applying stay here with them, because that is where someone
 * looking at a plugin is standing.
 */

const STATE_VARIANT: Record<string, "secondary" | "destructive" | "outline"> = {
  loaded: "secondary",
  incompatible: "outline",
  error: "destructive",
  pending: "outline",
}

/** A plugin ships no artwork, so the slot carries its initials instead - the
 * cards still line up with the integration ones beside them. */
function PluginMark({ name }: { name: string }) {
  const initials = name
    .split(/[\s-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("")
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-[13px] font-semibold text-muted-foreground">
      {initials || "?"}
    </span>
  )
}

export function PluginsSection() {
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
    onSuccess: () => toast.success("Applying - Danbyte will restart shortly."),
    onError: (e) => apiErrorToast(e),
  })

  const uninstall = useMutation({
    mutationFn: (module: string) =>
      api(`/api/plugins/${module}/uploaded/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plugins-list"] })
      toast.success("Removed - Apply changes to finish.")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!list.data) return null
  const plugins = list.data.plugins
  // The Apply prompt covers unapplied migrations OR an uploaded plugin that is
  // not loaded yet (both need a restart) - the server folds both into
  // needs_apply.
  const pending = list.data.needs_apply
  const busy = toggle.isPending || uninstall.isPending

  return (
    <section
      // Not a SettingsCard - it holds a grid of them - but it still owns the
      // anchor a settings-search result links to.
      id={cardAnchor("Plugins")}
      className="flex scroll-mt-6 flex-col gap-3 border-t border-border pt-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Plugins</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Installed as Python packages, or uploaded as a .tar.gz / .zip
            archive for an offline install - which runs its code on restart, so
            it is superuser only. Built-in ones ship with Danbyte: nothing to
            install, only a switch.
          </p>
        </div>
        {me.is_superuser && <UploadPlugin qc={qc} />}
      </div>

      {pending && me.is_superuser && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
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
        <ToggleCardGrid>
          {plugins.map((p) => (
            <PluginCard
              key={p.module}
              plugin={p}
              canManage={!!me.is_superuser}
              onToggle={(enabled) => toggle.mutate({ slug: p.slug, enabled })}
              onUninstall={() => uninstall.mutate(p.module)}
              busy={busy}
            />
          ))}
        </ToggleCardGrid>
      )}
    </section>
  )
}

function PluginCard({
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
    <ToggleCard
      title={plugin.name}
      logo={<PluginMark name={plugin.name} />}
      subtitle={
        <>
          {plugin.module}
          {plugin.version && ` · v${plugin.version}`}
        </>
      }
      description={plugin.error || plugin.description || "No description."}
      checked={plugin.enabled}
      disabled={busy}
      // A plugin that failed to load has nothing to switch - the card says
      // why instead of offering a control that would do nothing.
      onCheckedChange={loaded ? onToggle : undefined}
      status={
        loaded ? undefined : (
          <Badge variant={STATE_VARIANT[plugin.state] ?? "outline"}>
            {plugin.state}
          </Badge>
        )
      }
      badges={
        <>
          {plugin.builtin && <Badge variant="secondary">Built-in</Badge>}
          {plugin.uploaded && <Badge variant="secondary">Uploaded</Badge>}
          {plugin.unapplied_migrations.length > 0 && (
            <Badge variant="warning">
              {plugin.unapplied_migrations.length} migration
              {plugin.unapplied_migrations.length === 1 ? "" : "s"}
            </Badge>
          )}
        </>
      }
      action={
        canManage && plugin.uploaded ? (
          <ConfirmButton
            label="Uninstall"
            pendingLabel="Removing…"
            title={`Uninstall ${plugin.name}?`}
            body="Removes the uploaded plugin files and manifest entry. Takes effect after Apply changes (restart)."
            onConfirm={onUninstall}
            disabled={busy}
            destructive
            small
          />
        ) : undefined
      }
    />
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
    <>
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
    </>
  )
}

/** Destructive/irreversible plugin actions confirm first. */
export function ConfirmButton({
  label,
  pendingLabel,
  title,
  body,
  onConfirm,
  disabled,
  destructive,
  small,
  icon,
}: {
  label: string
  pendingLabel: string
  title: string
  body: string
  onConfirm: () => void
  disabled?: boolean
  destructive?: boolean
  small?: boolean
  /** Leading refresh glyph - for the restart actions. */
  icon?: boolean
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant={destructive ? "ghost" : "outline"}
          className={destructive ? "text-destructive" : undefined}
          disabled={disabled}
        >
          {icon && <RefreshCw className="h-3.5 w-3.5" />}
          {disabled ? pendingLabel : label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className={small ? "sm:max-w-md" : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : undefined}
            onClick={onConfirm}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
