import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeploymentSettings,
  SystemInfo,
  SystemUpdates,
  SystemUpgradeStatus,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/updates")({
  component: UpdatesSettingsPage,
})

function UpdatesSettingsPage() {
  const { canManageDeployment: canManage, isLoading } = useMe()
  const qc = useQueryClient()

  // Instant, network-free: version + environment. Renders immediately even
  // when the release-repo check below is slow/failing/disabled (airgapped).
  const info = useQuery({
    queryKey: ["system-info"],
    queryFn: () => api<SystemInfo>("/api/system/info/"),
    enabled: canManage,
  })
  const updates = useQuery({
    queryKey: ["system-updates"],
    queryFn: () => api<SystemUpdates>("/api/system/updates/"),
    enabled: canManage,
  })
  const settings = useQuery({
    queryKey: ["deployment-email"],
    queryFn: () => api<DeploymentSettings>("/api/deployment/email/"),
    enabled: canManage,
  })

  const [repoUrl, setRepoUrl] = useState("")
  const [token, setToken] = useState("")
  const [airgapped, setAirgapped] = useState(false)
  const [auto, setAuto] = useState(false)
  const [channel, setChannel] = useState<"stable" | "any">("stable")
  const [winDays, setWinDays] = useState("")
  const [winStart, setWinStart] = useState("")
  const [winEnd, setWinEnd] = useState("")
  useEffect(() => {
    if (!settings.data) return
    setRepoUrl(settings.data.release_repo_url)
    setAirgapped(settings.data.disable_update_check)
    setAuto(settings.data.auto_update_enabled)
    setChannel(settings.data.update_channel)
    setWinDays(settings.data.update_window_days)
    setWinStart(settings.data.update_window_start)
    setWinEnd(settings.data.update_window_end)
  }, [settings.data])

  const save = useMutation({
    mutationFn: () =>
      api<DeploymentSettings>("/api/deployment/email/", {
        method: "PUT",
        body: JSON.stringify({
          release_repo_url: repoUrl.trim(),
          ...(token.trim() ? { release_repo_token: token.trim() } : {}),
          disable_update_check: airgapped,
          // Airgapped ⇒ auto-update can't run; force it off so the two flags
          // never disagree.
          auto_update_enabled: airgapped ? false : auto,
          update_channel: channel,
          update_window_days: winDays.trim(),
          update_window_start: winStart.trim(),
          update_window_end: winEnd.trim(),
        }),
      }),
    onSuccess: () => {
      setToken("")
      void qc.invalidateQueries({ queryKey: ["deployment-email"] })
      void qc.invalidateQueries({ queryKey: ["system-updates"] })
      toast.success("Update settings saved")
    },
    onError: (e: unknown) => apiErrorToast(e, "Save failed"),
  })

  // ─── upgrade ───────────────────────────────────────────────────────────
  const [upgrading, setUpgrading] = useState(false)
  const status = useQuery({
    queryKey: ["upgrade-status"],
    queryFn: () => api<SystemUpgradeStatus>("/api/system/upgrade/status/"),
    enabled: upgrading,
    // Keep polling through the restart; failed fetches just retry.
    refetchInterval: 2000,
    retry: true,
  })
  const upgrade = useMutation({
    mutationFn: (version: string) =>
      api<{ launched: boolean }>("/api/system/upgrade/", {
        method: "POST",
        body: JSON.stringify({ version }),
      }),
    onSuccess: () => setUpgrading(true),
    onError: (e: unknown) => apiErrorToast(e, "Upgrade failed to start"),
  })
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null)
  const [confirmChecked, setConfirmChecked] = useState(false)
  const doUpgrade = (version: string) => {
    setConfirmChecked(false)
    setConfirmVersion(version)
  }
  // Upload-a-bundle upgrade — for offline/tarball installs that can't git-pull.
  const uploadUpgrade = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData()
      fd.append("bundle", file)
      return api<{ launched: boolean }>("/api/system/upgrade/upload/", {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: () => setUpgrading(true),
    onError: (e: unknown) => apiErrorToast(e, "Bundle upload failed"),
  })
  // Clear a STUCK upgrade lock — for when a previous upgrade was interrupted
  // and "An upgrade is already running" blocks new ones. The backend refuses
  // (409) if an upgrade is genuinely still alive, so this is safe to offer.
  const cancelStuck = useMutation({
    mutationFn: () =>
      api<{ cleared: boolean; had_lock: boolean }>(
        "/api/system/upgrade/cancel/",
        { method: "POST" },
      ),
    onSuccess: (r) => {
      setUpgrading(false)
      void qc.invalidateQueries({ queryKey: ["upgrade-status"] })
      toast.success(
        r.had_lock
          ? "Cleared the stuck upgrade — you can start a new one now."
          : "No upgrade lock was set; nothing to clear.",
      )
    },
    onError: (e: unknown) => apiErrorToast(e, "Couldn’t clear the upgrade"),
  })
  const st = status.data

  if (isLoading) return null
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to view updates.
      </p>
    )
  if (info.isError) return <QueryError error={info.error} />

  const d = updates.data
  const sys = info.data

  return (
    <div className="max-w-5xl space-y-8">
      {/* Current version — driven by the instant, network-free info endpoint. */}
      <section>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Updates</h2>
          {d?.update_available ? (
            <Badge className="bg-primary text-primary-foreground">
              Update available
            </Badge>
          ) : (
            d &&
            !d.error && (
              <Badge variant="secondary" className="text-[11px]">
                Up to date
              </Badge>
            )
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Running{" "}
          <span className="font-mono">v{sys?.version ?? "…"}</span>
          {sys?.commit && (
            <span className="font-mono text-xs"> ({sys.commit})</span>
          )}
          . Releases are read from{" "}
          <span className="font-mono text-xs">
            {d?.repo_url ?? settings.data?.release_repo_url ?? "…"}
          </span>
          .
        </p>
        {settings.data?.disable_update_check ? (
          <p className="mt-1 text-[13px] text-muted-foreground">
            Airgapped mode is on — the release repo is never contacted. Upgrade
            by uploading a bundle below.
          </p>
        ) : (
          d?.error && (
            <p className="mt-1 text-[13px] text-destructive">
              Couldn’t reach the repo: {d.error}
            </p>
          )
        )}

        {/* System info — Postgres/Django/etc, loads instantly. */}
        <dl className="mt-4 grid max-w-2xl grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-lg border border-border p-4 text-[13px]">
          {(
            [
              ["Danbyte", sys ? `v${sys.version}` : "…"],
              ["Commit", sys?.commit || (sys ? "not a git install" : "…")],
              ["Python", sys?.python || "…"],
              ["Django", sys?.django || "…"],
              ["PostgreSQL", sys?.postgres || "—"],
              ["Redis", sys?.redis || "—"],
              ["Platform", sys?.platform || "…"],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Release repo config */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Release source</h3>
        <p className="text-[13px] text-muted-foreground">
          Blank uses the official Danbyte repo. Set a custom repo (fork /
          private mirror) + a token for private repos.
        </p>
        <Field label="Repository URL">
          <Input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/danbyte-net/danbyte"
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={
            settings.data?.release_repo_token_set
              ? "GitHub token (set — leave blank to keep)"
              : "GitHub token (private repos)"
          }
        >
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
            className="font-mono text-xs"
          />
        </Field>

        <div className="space-y-3 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input
              type="checkbox"
              className="ck"
              checked={airgapped}
              onChange={(e) => setAirgapped(e.target.checked)}
            />
            Airgapped install (disable update check)
          </label>
          <p className="text-[12px] text-muted-foreground">
            When on, Danbyte never contacts the release repo — no version check,
            no automatic updates. Upgrade only by uploading a bundle below. Turn
            this on for installs with no outbound internet access.
          </p>
        </div>

        <div className="space-y-3 border-t border-border pt-3">
          <label
            className={
              "flex items-center gap-2 text-[13px] font-medium " +
              (airgapped ? "opacity-50" : "")
            }
          >
            <input
              type="checkbox"
              className="ck"
              checked={auto}
              disabled={airgapped}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Automatic updates
          </label>
          <p className="text-[12px] text-muted-foreground">
            When on, Danbyte upgrades itself (and auto-updating Outposts) to the
            newest release. Leave the window blank for real-time — upgrade as
            soon as a release appears.
            {airgapped && " Unavailable while airgapped mode is on."}
          </p>
          {auto && !airgapped && (
            <div className="space-y-2 pl-6">
              <Field label="Channel">
                <select
                  value={channel}
                  onChange={(e) =>
                    setChannel(e.target.value as "stable" | "any")
                  }
                  className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
                >
                  <option value="stable">Stable only</option>
                  <option value="any">Any (incl. prereleases)</option>
                </select>
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Days (blank = any)">
                  <Input
                    value={winDays}
                    onChange={(e) => setWinDays(e.target.value)}
                    placeholder="sun, sat"
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="From">
                  <Input
                    type="time"
                    value={winStart}
                    onChange={(e) => setWinStart(e.target.value)}
                    className="h-8 text-xs"
                  />
                </Field>
                <Field label="To">
                  <Input
                    type="time"
                    value={winEnd}
                    onChange={(e) => setWinEnd(e.target.value)}
                    className="h-8 text-xs"
                  />
                </Field>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Window is your server’s local time. Blank days/times = anytime.
              </p>
            </div>
          )}
        </div>

        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </section>

      {/* Offline / airgapped: upgrade by uploading a release bundle. */}
      <section className="space-y-2 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Upgrade from a bundle</h3>
        <p className="max-w-5xl text-[13px] text-muted-foreground">
          For offline or tarball installs that can&apos;t pull from the release
          repo: upload a{" "}
          <code className="font-mono">
            danbyte-&lt;version&gt;-linux-x86_64.tar.gz
          </code>{" "}
          and Danbyte checks its structure, backs up the DB, migrates, and
          restarts onto it. (One-click and automatic updates additionally verify
          the download&apos;s published SHA-256 — an uploaded file is trusted as
          you provided it, so only upload bundles you built or trust.)
        </p>
        <input
          type="file"
          accept=".tar.gz,.tgz,application/gzip"
          disabled={uploadUpgrade.isPending || upgrading}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) uploadUpgrade.mutate(f)
            e.currentTarget.value = ""
          }}
          className="block text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/70"
        />
        {uploadUpgrade.isPending && (
          <p className="text-[13px] text-muted-foreground">
            Uploading bundle… the upgrade will start automatically.
          </p>
        )}
      </section>

      {/* Releases + changelog */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Releases</h3>
        {updates.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !d?.releases.length ? (
          <p className="text-sm text-muted-foreground">
            No releases found in the repo yet.
          </p>
        ) : (
          d.releases.map((r) => (
            <div
              key={r.tag}
              className={
                "rounded-lg border p-3 " +
                (r.is_current
                  ? "border-primary/50 bg-primary/5"
                  : "border-border")
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium">{r.tag}</span>
                {r.name !== r.tag && (
                  <span className="text-[13px] text-muted-foreground">
                    {r.name}
                  </span>
                )}
                {r.is_current && (
                  <Badge variant="secondary" className="text-[10px]">
                    running
                  </Badge>
                )}
                {r.prerelease && (
                  <Badge variant="outline" className="text-[10px]">
                    prerelease
                  </Badge>
                )}
                {r.published_at && (
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(r.published_at).toLocaleDateString()}
                  </span>
                )}
                {!r.is_current && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 text-xs"
                    disabled={upgrade.isPending || upgrading}
                    onClick={() => doUpgrade(r.tag)}
                  >
                    Upgrade to this
                  </Button>
                )}
              </div>
              {r.body && (
                <pre className="mt-2 max-h-52 overflow-auto rounded-md bg-muted/40 p-2 text-[12px] whitespace-pre-wrap">
                  {r.body}
                </pre>
              )}
            </div>
          ))
        )}
        <p className="text-[11px] text-muted-foreground">
          Upgrading takes a DB backup, applies the release, and restarts
          Danbyte. Post-migration rollback isn’t automatic — the backup is the
          net.
        </p>
        <div className="flex items-center gap-3 border-t border-border pt-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={cancelStuck.isPending}
            onClick={() => cancelStuck.mutate()}
          >
            {cancelStuck.isPending ? "Clearing…" : "Clear a stuck upgrade"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Use only if a previous upgrade was interrupted and “An upgrade is
            already running” blocks new ones. It’s refused while an upgrade is
            genuinely in progress.
          </p>
        </div>
      </section>

      {/* Confirm before upgrading. */}
      <Dialog
        open={!!confirmVersion}
        onOpenChange={(o) => !o && setConfirmVersion(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upgrade Danbyte to {confirmVersion}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[13px]">
            <p>
              A database backup is taken first, then Danbyte applies the release
              and restarts (brief downtime).
            </p>
            <p className="text-muted-foreground">
              Post-migration rollback isn’t automatic — the backup is the net.
            </p>
            <label className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2.5">
              <input
                type="checkbox"
                className="ck"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
              />
              <span>
                I understand Danbyte will restart and this can’t be auto-undone.
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmVersion(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!confirmChecked}
                onClick={() => {
                  const v = confirmVersion
                  setConfirmVersion(null)
                  if (v) upgrade.mutate(v)
                }}
              >
                Upgrade to {confirmVersion}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Progress — polls through the restart (failed polls just retry). */}
      <Dialog
        open={upgrading}
        onOpenChange={(o) => {
          // Only closable once it's finished.
          if (!o && (st?.state === "done" || st?.state === "failed"))
            setUpgrading(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upgrading to {st?.version_to ?? "…"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={
                  "h-full transition-all " +
                  (st?.state === "failed" ? "bg-destructive" : "bg-primary")
                }
                style={{ width: `${st?.pct ?? 3}%` }}
              />
            </div>
            <div className="text-[13px]">
              {st?.state === "done" ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  ✓ Upgraded to {st.version_to}. Reload to use the new version.
                </span>
              ) : st?.state === "failed" ? (
                <span className="text-destructive">
                  Upgrade failed at “{st.step}”: {st.error}. Rolled back to the
                  previous version.
                </span>
              ) : status.isError ? (
                <span className="text-muted-foreground">
                  Applying… Danbyte is restarting; reconnecting…
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {st?.step ? `${st.step}…` : "Starting…"}
                </span>
              )}
            </div>
            {st?.state === "done" && (
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload
              </Button>
            )}
            {st?.state === "failed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setUpgrading(false)}
              >
                Close
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
