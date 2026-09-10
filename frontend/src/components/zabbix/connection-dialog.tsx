import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { CheckStatus, ZabbixConnection, ZabbixDefaults } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { useSaveObject } from "@/lib/save-object"

/** Create or edit the Zabbix connection (#162). */
export function ZabbixConnectionDialog({
  connection,
  open,
  onOpenChange,
  onSaved,
}: {
  connection: ZabbixConnection | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {connection ? `Edit ${connection.name}` : "Add Zabbix connection"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <ConnectionForm
            connection={connection}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

const MODES = [
  { value: "off", label: "Off - Danbyte writes nothing" },
  { value: "review", label: "Review - propose changes for approval" },
  { value: "auto", label: "Auto - apply changes" },
]

function ConnectionForm({
  connection,
  onSaved,
  onCancel,
}: {
  connection: ZabbixConnection | null
  onSaved: () => void
  onCancel: () => void
}) {
  const isEdit = !!connection
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(connection?.name ?? "")
  const [url, setUrl] = useState(connection?.url ?? "")
  const [token, setToken] = useState("")
  const [verifyTls, setVerifyTls] = useState(connection?.verify_tls ?? true)
  const [enabled, setEnabled] = useState(connection?.enabled ?? true)
  const [mode, setMode] = useState<string | null>(
    connection?.provision_mode ?? "off"
  )
  const [autoSync, setAutoSync] = useState(connection?.auto_sync ?? false)
  const [interval, setInterval] = useState(
    String(connection?.sync_interval_minutes ?? 60)
  )
  const [prune, setPrune] = useState(connection?.prune_hosts ?? false)
  const [pruneAfter, setPruneAfter] = useState(
    String(connection?.prune_after_days ?? 7)
  )
  const [severity, setSeverity] = useState<Record<string, string>>(
    connection?.severity_map ?? {}
  )

  // The severity list comes from the server so Zabbix's enum is not
  // hard-coded in two languages.
  const defaults = useQuery({
    queryKey: ["zabbix-defaults"],
    queryFn: () => api<ZabbixDefaults>("/api/zabbix/connections/defaults/"),
    staleTime: 60 * 60_000,
  })
  const rows = useMemo(() => defaults.data?.severities ?? [], [defaults.data])
  // Which states a severity may mean is the server's call, and each renders as
  // the pill it renders as everywhere else - so a tenant that calls `down`
  // "Critical" maps Disaster onto Critical, in Critical's own red.
  const statusOptions = useMemo(
    () =>
      (defaults.data?.statuses ?? []).map((o) => ({
        value: o.value,
        label: <CheckStatusBadge status={o.value as CheckStatus} />,
      })),
    [defaults.data]
  )
  // The stored map only holds what has been overridden, so the default fills
  // the rest in - a severity with no answer would otherwise read as `up`.
  const effective = (value: string) =>
    severity[value] || defaults.data?.default_map[value] || "up"

  const mutation = useMutation({
    mutationFn: () =>
      saveObject<ZabbixConnection>({
        objectType: "zabbix.zabbixconnection",
        endpoint: "/api/zabbix/connections/",
        id: isEdit ? connection.id : undefined,
        payload: {
          name: name.trim(),
          url: url.trim(),
          // Blank keeps what is stored: this field never shows the secret, so
          // saving an untouched form must not wipe it.
          ...(token ? { token } : {}),
          verify_tls: verifyTls,
          enabled,
          provision_mode: mode,
          auto_sync: autoSync,
          sync_interval_minutes: Number(interval) || 60,
          prune_hosts: prune,
          prune_after_days: Number(pruneAfter) || 0,
          severity_map: severity,
        },
      }),
    onSuccess: (saved) => {
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`)
      onSaved()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormSection title="Connection" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="zabbix-prod"
          error={fieldErrors.name}
        />
        <FormText
          label="Frontend URL"
          required
          mono
          hint="Danbyte appends /api_jsonrpc.php"
          value={url}
          onChange={setUrl}
          placeholder="https://zabbix.example.com"
          error={fieldErrors.url}
        />
        <FormText
          label="API token"
          type="password"
          hint={
            connection?.token_set
              ? "set - blank keeps the current one"
              : "a named token from Users → API tokens; give it an expiry"
          }
          value={token}
          onChange={setToken}
          placeholder={connection?.token_set ? "••••••" : ""}
          error={fieldErrors.token}
        />
        <FormCheckbox
          label="Verify TLS certificate"
          checked={verifyTls}
          onChange={setVerifyTls}
        />
        <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      </FormSection>

      <FormSection title="Provisioning" card>
        <FormSelect
          label="Write hosts into Zabbix"
          hint="Reading is one decision; writing is another"
          value={mode}
          onChange={setMode}
          options={MODES}
          error={fieldErrors.provision_mode}
        />
        {mode !== "off" && (
          <>
            <FormCheckbox
              label="Sync automatically"
              hint="Off runs only when you press Sync."
              checked={autoSync}
              onChange={setAutoSync}
            />
            {autoSync && (
              <FormText
                label="Every"
                type="number"
                hint="minutes between passes (5 - 1440)"
                value={interval}
                onChange={setInterval}
                error={fieldErrors.sync_interval_minutes}
              />
            )}
            <FormCheckbox
              label="Remove hosts Danbyte created and no longer needs"
              hint="Never touches a host somebody else made."
              checked={prune}
              onChange={setPrune}
            />
            {prune && (
              <FormText
                label="Remove after"
                type="number"
                hint="days a host must stay unwanted first"
                value={pruneAfter}
                onChange={setPruneAfter}
                error={fieldErrors.prune_after_days}
              />
            )}
          </>
        )}
      </FormSection>

      <FormSection title="Severity mapping" card>
        <p className="text-xs text-muted-foreground">
          What a Zabbix problem means for a Danbyte status. Worst wins - one
          Disaster among a dozen Warnings is a down host.
        </p>
        <div className="grid gap-2">
          {rows.map((row) => (
            <div key={row.value} className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-[13px]">{row.label}</span>
              <div className="min-w-0 flex-1">
                <FormSelect
                  label=""
                  value={effective(row.value)}
                  onChange={(v) =>
                    setSeverity((prev) => ({ ...prev, [row.value]: v ?? "up" }))
                  }
                  options={statusOptions}
                />
              </div>
            </div>
          ))}
        </div>
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Add connection"}
      />
    </form>
  )
}
