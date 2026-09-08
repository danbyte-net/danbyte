import { useEffect, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import {
  Download,
  Lock,
  LockOpen,
  MoreHorizontal,
  Play,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import { api, formatBytes } from "@/lib/api"
import type {
  Backup,
  BackupComponent,
  BackupRunStatus,
  BackupSchedule,
  BackupStep,
  BackupTarget,
  BackupsStatus,
  NotificationChannel,
  Paginated,
  RestorePreview,
  RestoreRun,
  StorageKind,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import {
  CadenceFields,
  DEFAULT_CADENCE,
  RetentionFields,
} from "@/components/settings/cadence-fields"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SimpleTable } from "@/components/ui/simple-table"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { Field } from "@/components/forms/field"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormSelect } from "@/components/forms/select"
import { FormText } from "@/components/forms/text"
import { CheckList } from "@/components/forms/check-list"

export const Route = createFileRoute("/settings/backups")({
  component: BackupsSettingsPage,
})

// ─── shared bits ─────────────────────────────────────────────────────────────

const COMPONENT_OPTIONS: {
  value: BackupComponent
  label: string
  hint: string
}[] = [
  { value: "db", label: "Database", hint: "every object, user and setting" },
  { value: "media", label: "Media", hint: "images, documents, plugin uploads" },
  { value: "config", label: "Config", hint: "non-secret deployment settings" },
]

const COMPONENT_LABEL: Record<BackupComponent, string> = {
  db: "Database",
  media: "Media",
  config: "Config",
}

const KIND_LABEL: Record<Backup["kind"], string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  pre_upgrade: "Before upgrade",
  pre_restore: "Before restore",
  uploaded: "Uploaded",
}

const STATUS_LABEL: Record<BackupRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Success",
  failed: "Failed",
}

function RunStatus({ status }: { status: BackupRunStatus }) {
  const variant =
    status === "success"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "running"
          ? "warning"
          : "secondary"
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>
}

function componentsText(list: BackupComponent[]) {
  return list.map((c) => COMPONENT_LABEL[c]).join(", ")
}

function StepList({ steps, error }: { steps: BackupStep[]; error?: string }) {
  if (steps.length === 0)
    return <p className="text-xs text-muted-foreground">Not started.</p>
  return (
    <ol className="space-y-1 text-xs">
      {steps.map((s) => (
        <li key={s.name} className="flex items-start gap-2">
          <RunStatus status={s.status} />
          <span className="font-medium">{s.name}</span>
          {s.detail && (
            <span className="text-muted-foreground">{s.detail}</span>
          )}
        </li>
      ))}
      {error && <li className="text-destructive">{error}</li>}
    </ol>
  )
}

const isActive = (s: BackupRunStatus) => s === "queued" || s === "running"

// ─── page ────────────────────────────────────────────────────────────────────

function BackupsSettingsPage() {
  const { canManageDeployment: canManage, isLoading } = useMe()
  const status = useQuery({
    queryKey: ["backups-status"],
    queryFn: () => api<BackupsStatus>("/api/backups/status/"),
    enabled: canManage,
    refetchInterval: 15_000,
  })

  if (isLoading) return null
  if (!canManage)
    return (
      <EmptyState title="Deployment admin required">
        Backups cover the whole deployment.
      </EmptyState>
    )

  return (
    <div>
      <SettingsHeader title="Backups">
        Encrypted archives of the database, media and configuration. An archive
        only opens on a host with the same MONITORING_SECRET_KEY.
      </SettingsHeader>
      {status.data?.maintenance && (
        <div className="border-warning/40 bg-warning/10 mb-4 rounded-md border px-3 py-2 text-xs">
          Restore in progress: {status.data.maintenance.reason}. The site
          answers 503 until it finishes.
        </div>
      )}
      <SettingsGrid>
        <TargetsCard kinds={status.data?.storage_kinds ?? []} />
        <SchedulesCard />
      </SettingsGrid>
      <div className="mt-4 space-y-4">
        <BackupsCard status={status.data} />
        <RestoresCard />
      </div>
    </div>
  )
}

// ─── targets ─────────────────────────────────────────────────────────────────

function TargetsCard({ kinds }: { kinds: StorageKind[] }) {
  const qc = useQueryClient()
  const targets = useQuery({
    queryKey: ["backup-targets"],
    queryFn: () => api<Paginated<BackupTarget>>("/api/backups/targets/"),
  })
  const [editing, setEditing] = useState<BackupTarget | "new" | null>(null)
  const [removing, setRemoving] = useState<BackupTarget | null>(null)
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["backup-targets"] })
  }
  const test = useMutation({
    mutationFn: (t: BackupTarget) =>
      api<{ ok: boolean; detail: string }>(
        `/api/backups/targets/${t.id}/test/`,
        { method: "POST" }
      ),
    onSuccess: (r) => {
      toast.success(r.detail)
      invalidate()
    },
    onError: (e) => {
      apiErrorToast(e)
      invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (t: BackupTarget) =>
      api(`/api/backups/targets/${t.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <SettingsCard
      title="Targets"
      description="Where archives are stored."
      footer={
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          Add target
        </Button>
      }
    >
      {targets.error ? (
        <QueryError error={targets.error} />
      ) : (
        <SimpleTable
          columns={[
            {
              id: "name",
              header: "Name",
              cell: (t: BackupTarget) => (
                <span className="flex items-center gap-2">
                  {t.name}
                  {t.is_default && <Badge variant="secondary">default</Badge>}
                  {!t.enabled && <Badge variant="outline">disabled</Badge>}
                </span>
              ),
            },
            {
              id: "location",
              header: "Location",
              flex: true,
              cell: (t: BackupTarget) => (
                <div>
                  <div className="font-mono text-xs">{t.location}</div>
                  {t.last_error && (
                    <div className="text-xs text-destructive">
                      {t.last_error}
                    </div>
                  )}
                </div>
              ),
            },
            {
              id: "actions",
              header: "",
              align: "right",
              cell: (t: BackupTarget) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Actions">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => test.mutate(t)}>
                      Test
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEditing(t)}>
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setRemoving(t)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
            },
          ]}
          data={targets.data?.results ?? []}
          getRowKey={(t) => t.id}
          empty="No targets."
        />
      )}
      {editing && (
        <TargetDialog
          kinds={kinds}
          target={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only a target without backups or schedules can go. Archives on
              disk are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

function TargetDialog({
  kinds,
  target,
  onClose,
  onSaved,
}: {
  kinds: StorageKind[]
  target: BackupTarget | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(target?.name ?? "")
  const [kind, setKind] = useState(
    target?.kind ?? (kinds.length ? kinds[0].kind : "local")
  )
  const [config, setConfig] = useState<Record<string, unknown>>(
    target?.config ?? {}
  )
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [isDefault, setIsDefault] = useState(target?.is_default ?? false)
  const [enabled, setEnabled] = useState(target?.enabled ?? true)
  const spec = kinds.find((k) => k.kind === kind)

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name,
        kind,
        config,
        is_default: isDefault,
        enabled,
      }
      if (Object.keys(creds).length) body.credentials = creds
      return target
        ? api(`/api/backups/targets/${target.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/backups/targets/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target ? "Edit target" : "Add target"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <FormText label="Name" value={name} onChange={setName} required />
          <FormSelect
            label="Kind"
            value={kind}
            onChange={(v) => {
              setKind(v ?? "local")
              setConfig({})
              setCreds({})
            }}
            options={kinds.map((k) => ({ value: k.kind, label: k.label }))}
            disabled={!!target}
          />
          {spec?.fields.map((f) =>
            f.type === "checkbox" ? (
              <FormCheckbox
                key={f.name}
                label={f.label}
                checked={Boolean(config[f.name] ?? f.default ?? false)}
                onChange={(v) => setConfig({ ...config, [f.name]: v })}
              />
            ) : (
              <FormText
                key={f.name}
                label={f.label}
                type={f.type}
                value={
                  f.secret
                    ? (creds[f.name] ?? "")
                    : String(config[f.name] ?? "")
                }
                onChange={(v) =>
                  f.secret
                    ? setCreds({ ...creds, [f.name]: v })
                    : setConfig({ ...config, [f.name]: v })
                }
                placeholder={
                  f.secret && target?.has_credentials
                    ? "unchanged"
                    : f.placeholder
                }
                autoComplete="off"
              />
            )
          )}
          <FormCheckbox
            label="Default target"
            checked={isDefault}
            onChange={setIsDefault}
          />
          <FormCheckbox
            label="Enabled"
            checked={enabled}
            onChange={setEnabled}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── schedules ───────────────────────────────────────────────────────────────

function SchedulesCard() {
  const qc = useQueryClient()
  const schedules = useQuery({
    queryKey: ["backup-schedules"],
    queryFn: () => api<Paginated<BackupSchedule>>("/api/backups/schedules/"),
  })
  const [editing, setEditing] = useState<BackupSchedule | "new" | null>(null)
  const [removing, setRemoving] = useState<BackupSchedule | null>(null)
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["backup-schedules"] })
    void qc.invalidateQueries({ queryKey: ["backups"] })
  }
  const run = useMutation({
    mutationFn: (s: BackupSchedule) =>
      api<Backup>(`/api/backups/schedules/${s.id}/run/`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Backup queued")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })
  const toggle = useMutation({
    mutationFn: (s: BackupSchedule) =>
      api(`/api/backups/schedules/${s.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled }),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: (s: BackupSchedule) =>
      api(`/api/backups/schedules/${s.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <SettingsCard
      title="Schedules"
      description="Recurring backups with retention."
      footer={
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          Add schedule
        </Button>
      }
    >
      {schedules.error ? (
        <QueryError error={schedules.error} />
      ) : (
        <SimpleTable
          columns={[
            {
              id: "name",
              header: "Name",
              flex: true,
              cell: (s: BackupSchedule) => (
                <div>
                  <div>{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.cadence_label} · {componentsText(s.components)} ·{" "}
                    {s.target_name}
                  </div>
                </div>
              ),
            },
            {
              id: "next",
              header: "Next",
              cell: (s: BackupSchedule) =>
                s.next_run_at ? (
                  <TimeCell iso={s.next_run_at} />
                ) : (
                  <span className="text-xs text-muted-foreground">off</span>
                ),
            },
            {
              id: "last",
              header: "Last",
              cell: (s: BackupSchedule) =>
                s.last_backup_status ? (
                  <RunStatus status={s.last_backup_status} />
                ) : null,
            },
            {
              id: "enabled",
              header: "",
              cell: (s: BackupSchedule) => (
                <Switch
                  checked={s.enabled}
                  onCheckedChange={() => toggle.mutate(s)}
                  aria-label="Enabled"
                />
              ),
            },
            {
              id: "actions",
              header: "",
              align: "right",
              cell: (s: BackupSchedule) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Actions">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => run.mutate(s)}>
                      <Play className="size-3.5" /> Run now
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEditing(s)}>
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setRemoving(s)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
            },
          ]}
          data={schedules.data?.results ?? []}
          getRowKey={(s) => s.id}
          empty="No schedules."
        />
      )}
      {editing && (
        <ScheduleDialog
          schedule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Backups it already made stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

function ScheduleDialog({
  schedule,
  onClose,
  onSaved,
}: {
  schedule: BackupSchedule | null
  onClose: () => void
  onSaved: () => void
}) {
  const targets = useQuery({
    queryKey: ["backup-targets"],
    queryFn: () => api<Paginated<BackupTarget>>("/api/backups/targets/"),
  })
  const channels = useQuery({
    queryKey: ["notification-channels"],
    queryFn: () =>
      api<Paginated<NotificationChannel>>("/api/monitoring/channels/"),
  })
  const [name, setName] = useState(schedule?.name ?? "")
  const [components, setComponents] = useState<BackupComponent[]>(
    schedule?.components ?? ["db", "media", "config"]
  )
  const [target, setTarget] = useState<string | null>(schedule?.target ?? null)
  const [cadence, setCadence] = useState(schedule?.cadence ?? DEFAULT_CADENCE)
  const [retention, setRetention] = useState(
    schedule?.retention ?? { max_count: 14, max_age_days: null }
  )
  const [notify, setNotify] = useState<string[]>(
    schedule?.notify_channels ?? []
  )
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true)

  const targetOptions = (targets.data?.results ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({ value: t.id, label: t.name }))
  useEffect(() => {
    if (!target && targets.data) {
      const def = targets.data.results.find((t) => t.is_default && t.enabled)
      if (def) setTarget(def.id)
    }
  }, [target, targets.data])

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        components,
        target,
        cadence,
        retention,
        notify_channels: notify,
        enabled,
      }
      return schedule
        ? api(`/api/backups/schedules/${schedule.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/backups/schedules/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {schedule ? "Edit schedule" : "Add schedule"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <FormText label="Name" value={name} onChange={setName} required />
          <Field label="Components">
            <CheckList
              options={COMPONENT_OPTIONS}
              value={components}
              onChange={setComponents}
            />
          </Field>
          <FormSelect
            label="Target"
            value={target}
            onChange={setTarget}
            options={targetOptions}
          />
          <CadenceFields value={cadence} onChange={setCadence} />
          <Field
            label="Retention"
            hint="Older or surplus backups are deleted after each run. Protected backups stay."
          >
            <RetentionFields value={retention} onChange={setRetention} />
          </Field>
          <Field label="Notify">
            <CheckList
              options={(channels.data?.results ?? []).map((c) => ({
                value: c.id,
                label: c.name,
                hint: c.kind,
              }))}
              value={notify}
              onChange={setNotify}
              empty="No notification channels yet."
            />
          </Field>
          <FormCheckbox
            label="Enabled"
            checked={enabled}
            onChange={setEnabled}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending || !name.trim() || !target || !components.length
            }
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── backups ─────────────────────────────────────────────────────────────────

function BackupsCard({ status }: { status: BackupsStatus | undefined }) {
  const qc = useQueryClient()
  const backups = useQuery({
    queryKey: ["backups"],
    queryFn: () => api<Paginated<Backup>>("/api/backups/"),
    refetchInterval: (q) =>
      q.state.data?.results.some((b) => isActive(b.status)) ? 3_000 : false,
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["backups"] })
    void qc.invalidateQueries({ queryKey: ["backups-status"] })
  }
  const [backupNow, setBackupNow] = useState(false)
  const [steps, setSteps] = useState<Backup | null>(null)
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [removing, setRemoving] = useState<Backup | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData()
      body.append("file", file)
      return api<Backup>("/api/backups/upload/", { method: "POST", body })
    },
    onSuccess: (b) => {
      toast.success(`Uploaded ${b.filename}`)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })
  const protect = useMutation({
    mutationFn: (b: Backup) =>
      api(`/api/backups/${b.id}/protect/`, {
        method: "POST",
        body: JSON.stringify({ protected: !b.protected }),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: (b: Backup) =>
      api(`/api/backups/${b.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns: ColumnDef<Backup>[] = [
    {
      id: "created",
      accessorKey: "created_at",
      header: "Created",
      cell: ({ row }) => <TimeCell iso={row.original.created_at} />,
    },
    {
      id: "kind",
      accessorKey: "kind",
      header: "Kind",
      cell: ({ row }) => (
        <Badge variant="secondary">{KIND_LABEL[row.original.kind]}</Badge>
      ),
    },
    {
      id: "filename",
      accessorKey: "filename",
      header: "Archive",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {row.original.filename || "—"}
        </span>
      ),
    },
    {
      id: "components",
      header: "Components",
      cell: ({ row }) => componentsText(row.original.components),
    },
    {
      id: "target",
      accessorKey: "target_name",
      header: "Target",
    },
    {
      id: "size",
      accessorKey: "size",
      header: "Size",
      cell: ({ row }) =>
        row.original.size == null ? "" : formatBytes(row.original.size),
    },
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          <RunStatus status={row.original.status} />
          {row.original.protected && (
            <Lock
              className="size-3.5 text-muted-foreground"
              aria-label="Protected"
            />
          )}
        </span>
      ),
    },
    {
      id: "by",
      accessorKey: "created_by_name",
      header: "By",
      cell: ({ row }) =>
        row.original.created_by_name ?? row.original.schedule_name ?? "",
    },
    {
      id: "actions",
      header: "",
      enableHiding: false,
      cell: ({ row }) => {
        const b = row.original
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSteps(b)}>
                Steps
              </DropdownMenuItem>
              {b.status === "success" && (
                <>
                  <DropdownMenuItem asChild>
                    <a href={`/api/backups/${b.id}/download/`} download>
                      <Download className="size-3.5" /> Download
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setRestoring(b)}
                    disabled={!!status?.restore_in_progress}
                  >
                    <RotateCcw className="size-3.5" /> Restore…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => protect.mutate(b)}>
                    {b.protected ? (
                      <>
                        <LockOpen className="size-3.5" /> Unprotect
                      </>
                    ) : (
                      <>
                        <Lock className="size-3.5" /> Protect
                      </>
                    )}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={b.protected || isActive(b.status)}
                onClick={() => setRemoving(b)}
              >
                <Trash2 className="size-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    },
  ]

  return (
    <SettingsCard
      title="Backups"
      badge={
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".dbk"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) upload.mutate(f)
              e.target.value = ""
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
          >
            <Upload className="size-3.5" />
            {upload.isPending ? "Uploading..." : "Upload backup"}
          </Button>
          <Button
            size="sm"
            onClick={() => setBackupNow(true)}
            disabled={!!status?.restore_in_progress}
          >
            Back up now
          </Button>
        </div>
      }
    >
      {backups.error ? (
        <QueryError error={backups.error} />
      ) : (
        <DataTable
          data={backups.data?.results ?? []}
          columns={columns}
          flexColumn="filename"
          tableId="backups"
          enableExport={false}
        />
      )}
      {backupNow && (
        <BackupNowDialog
          onClose={() => setBackupNow(false)}
          onQueued={invalidate}
        />
      )}
      {steps && (
        <Dialog open onOpenChange={(o) => !o && setSteps(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {steps.filename || KIND_LABEL[steps.kind]}
              </DialogTitle>
              <DialogDescription>
                {componentsText(steps.components)} · {steps.target_name}
                {steps.summary.version && ` · Danbyte ${steps.summary.version}`}
              </DialogDescription>
            </DialogHeader>
            <StepList steps={steps.steps} error={steps.error} />
          </DialogContent>
        </Dialog>
      )}
      {restoring && status && (
        <RestoreDialog
          backup={restoring}
          deploymentName={status.deployment_name}
          onClose={() => {
            setRestoring(null)
            invalidate()
          }}
        />
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.filename} is removed from {removing?.target_name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

function BackupNowDialog({
  onClose,
  onQueued,
}: {
  onClose: () => void
  onQueued: () => void
}) {
  const targets = useQuery({
    queryKey: ["backup-targets"],
    queryFn: () => api<Paginated<BackupTarget>>("/api/backups/targets/"),
  })
  const [components, setComponents] = useState<BackupComponent[]>([
    "db",
    "media",
    "config",
  ])
  const [target, setTarget] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      api<Backup>("/api/backups/", {
        method: "POST",
        body: JSON.stringify({ components, target: target || undefined }),
      }),
    onSuccess: () => {
      toast.success("Backup queued")
      onQueued()
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Back up now</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Components">
            <CheckList
              options={COMPONENT_OPTIONS}
              value={components}
              onChange={setComponents}
            />
          </Field>
          <FormSelect
            label="Target"
            value={target}
            onChange={setTarget}
            noneLabel="Default target"
            options={(targets.data?.results ?? [])
              .filter((t) => t.enabled)
              .map((t) => ({ value: t.id, label: t.name }))}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || components.length === 0}
          >
            {create.isPending ? "Queuing..." : "Start backup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── restore ─────────────────────────────────────────────────────────────────

function RestoreDialog({
  backup,
  deploymentName,
  onClose,
}: {
  backup: Backup
  deploymentName: string
  onClose: () => void
}) {
  const preview = useQuery({
    queryKey: ["backup-preview", backup.id],
    queryFn: () => api<RestorePreview>(`/api/backups/${backup.id}/preview/`),
  })
  const [components, setComponents] = useState<BackupComponent[]>(
    backup.components
  )
  const [confirm, setConfirm] = useState("")
  const [runId, setRunId] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: () =>
      api<RestoreRun>(`/api/backups/${backup.id}/restore/`, {
        method: "POST",
        body: JSON.stringify({ components, confirm }),
      }),
    onSuccess: (run) => setRunId(run.id),
    onError: (e) => apiErrorToast(e),
  })

  // The run endpoint stays reachable while everything else answers 503, so
  // keep retrying through the maintenance window.
  const run = useQuery({
    queryKey: ["restore-run", runId],
    queryFn: () => api<RestoreRun>(`/api/backups/restore-runs/${runId}/`),
    enabled: !!runId,
    refetchInterval: (q) =>
      q.state.data && !isActive(q.state.data.status) ? false : 2_000,
    retry: true,
    retryDelay: 2_000,
  })

  const pv = preview.data
  const available = pv?.components ?? backup.components
  const counts = Object.entries(pv?.counts ?? {}).filter(([, n]) => n > 0)

  return (
    <Dialog open onOpenChange={(o) => !o && !runId && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore {backup.filename}</DialogTitle>
          <DialogDescription>
            {backup.summary.deployment_name}
            {backup.summary.version && ` · Danbyte ${backup.summary.version}`}
            {backup.summary.created_at && " · "}
            {backup.summary.created_at && (
              <TimeCell iso={backup.summary.created_at} />
            )}
          </DialogDescription>
        </DialogHeader>

        {runId ? (
          <div className="space-y-3">
            <StepList steps={run.data?.steps ?? []} error={run.data?.error} />
            {run.data?.status === "success" && (
              <p className="text-xs">
                Restored. Reload to see the restored data.
              </p>
            )}
            {run.data?.status === "failed" && run.data.safety_backup && (
              <p className="text-xs text-muted-foreground">
                The state from before the restore is kept as a protected backup
                in the list.
              </p>
            )}
            <DialogFooter>
              {run.data && !isActive(run.data.status) ? (
                run.data.status === "success" ? (
                  <Button onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                ) : (
                  <Button variant="outline" onClick={onClose}>
                    Close
                  </Button>
                )
              ) : (
                <Button disabled>Restoring...</Button>
              )}
            </DialogFooter>
          </div>
        ) : preview.error ? (
          <QueryError error={preview.error} />
        ) : !pv ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-1 text-xs">
              {pv.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2">
                  <Badge variant={c.ok ? "success" : "destructive"}>
                    {c.ok ? "ok" : "blocked"}
                  </Badge>
                  <span>{c.detail}</span>
                </li>
              ))}
            </ul>
            {counts.length > 0 && (
              <div className="rounded-md border border-border p-2 text-xs">
                <div className="mb-1 font-medium">This replaces</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
                  {counts.map(([k, n]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="tabular-nums">{n}</span>
                    </div>
                  ))}
                  {pv.media_files != null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">files</span>
                      <span className="tabular-nums">{pv.media_files}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            <Field label="Components">
              <CheckList
                options={COMPONENT_OPTIONS.filter((o) =>
                  available.includes(o.value)
                )}
                value={components}
                onChange={setComponents}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              A protected backup of the current state is taken first. The site
              is unavailable while the database is replaced.
            </p>
            <Field label={`Type ${deploymentName} to confirm`}>
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => start.mutate()}
                disabled={
                  start.isPending ||
                  !pv.can_restore ||
                  components.length === 0 ||
                  confirm.trim() !== deploymentName
                }
              >
                {start.isPending ? "Starting..." : "Restore"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ─── restores ────────────────────────────────────────────────────────────────

function RestoresCard() {
  const runs = useQuery({
    queryKey: ["restore-runs"],
    queryFn: () => api<Paginated<RestoreRun>>("/api/backups/restore-runs/"),
    refetchInterval: (q) =>
      q.state.data?.results.some((r) => isActive(r.status)) ? 3_000 : false,
  })
  const [steps, setSteps] = useState<RestoreRun | null>(null)
  const rows = runs.data?.results ?? []
  if (!runs.error && rows.length === 0) return null
  return (
    <SettingsCard title="Restores">
      {runs.error ? (
        <QueryError error={runs.error} />
      ) : (
        <SimpleTable
          columns={[
            {
              id: "when",
              header: "Started",
              cell: (r: RestoreRun) => <TimeCell iso={r.created_at} />,
            },
            {
              id: "archive",
              header: "Archive",
              flex: true,
              cell: (r: RestoreRun) => (
                <span className="font-mono text-xs">{r.backup_filename}</span>
              ),
            },
            {
              id: "components",
              header: "Components",
              cell: (r: RestoreRun) => componentsText(r.components),
            },
            {
              id: "status",
              header: "Status",
              cell: (r: RestoreRun) => <RunStatus status={r.status} />,
            },
            {
              id: "by",
              header: "By",
              cell: (r: RestoreRun) => r.created_by_name ?? "",
            },
            {
              id: "steps",
              header: "",
              align: "right",
              cell: (r: RestoreRun) => (
                <Button size="sm" variant="ghost" onClick={() => setSteps(r)}>
                  Steps
                </Button>
              ),
            },
          ]}
          data={rows}
          getRowKey={(r) => r.id}
        />
      )}
      {steps && (
        <Dialog open onOpenChange={(o) => !o && setSteps(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Restore of {steps.backup_filename}</DialogTitle>
            </DialogHeader>
            <StepList steps={steps.steps} error={steps.error} />
          </DialogContent>
        </Dialog>
      )}
    </SettingsCard>
  )
}
