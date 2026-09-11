import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  CheckStatus,
  MonitoringEngine,
  Paginated,
  ZabbixConnection,
  ZabbixDefaults,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FormCheckbox,
  FormColumn,
  FormColumns,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { DeviceTypePicker } from "@/components/device-type-picker"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
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
      <DialogContent size="4xl" className="max-h-[85vh] overflow-y-auto">
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

const SCOPES = [
  { value: "checks", label: "Devices with a Zabbix check" },
  { value: "rules", label: "Every device the rules match" },
]

const MODES = [
  { value: "off", label: "Off" },
  { value: "review", label: "Review" },
  { value: "auto", label: "Auto" },
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
  const [engineIds, setEngineIds] = useState<string[]>(
    connection?.engines ?? []
  )
  const [mode, setMode] = useState<string | null>(
    connection?.provision_mode ?? "off"
  )
  const [scope, setScope] = useState<string | null>(
    connection?.provision_scope ?? "checks"
  )
  const [autoSync, setAutoSync] = useState(connection?.auto_sync ?? false)
  const [interval, setInterval] = useState(
    String(connection?.sync_interval_minutes ?? 60)
  )
  const [sendCreds, setSendCreds] = useState(
    connection?.send_snmp_credentials ?? false
  )
  const [prune, setPrune] = useState(connection?.prune_hosts ?? false)
  const [syncMaint, setSyncMaint] = useState(
    connection?.sync_maintenance ?? false
  )
  const [writeAcks, setWriteAcks] = useState(
    connection?.write_acknowledgements ?? false
  )
  const [readInventory, setReadInventory] = useState(
    connection?.read_inventory ?? false
  )
  const [adopt, setAdopt] = useState(connection?.adopt_hosts ?? false)
  const [adoptSite, setAdoptSite] = useState<string | null>(
    connection?.adopt_site ?? null
  )
  const [adoptRole, setAdoptRole] = useState<string | null>(
    connection?.adopt_role ?? null
  )
  const [adoptType, setAdoptType] = useState<string | null>(
    connection?.adopt_device_type ?? null
  )
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
  // Which engines read through this connection. Explicit, because guessing by
  // name meant a second Zabbix could answer for the first.
  const engines = useQuery({
    queryKey: ["zabbix-engine-picker"],
    queryFn: () => api<Paginated<MonitoringEngine>>("/api/monitoring/engines/"),
    staleTime: 60_000,
  })
  // Small catalogs, read whole; the device-type catalog is not, and gets the
  // real picker below.
  const sites = useQuery({
    queryKey: ["zabbix-adopt-sites"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?page_size=500"),
    staleTime: 60_000,
    enabled: adopt,
  })
  const roles = useQuery({
    queryKey: ["zabbix-adopt-roles"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/device-roles/?page_size=500"
      ),
    staleTime: 60_000,
    enabled: adopt,
  })
  const asOptions = (rows?: { id: string; name: string }[]) =>
    (rows ?? []).map((r) => ({ value: r.id, label: r.name }))
  const engineOptions = useMemo(
    () =>
      (engines.data?.results ?? [])
        .filter((e) => e.kind === "zabbix")
        .map((e) => ({ id: e.id, name: e.name })),
    [engines.data]
  )

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
          engines: engineIds,
          provision_mode: mode,
          provision_scope: scope,
          auto_sync: autoSync,
          sync_interval_minutes: Number(interval) || 60,
          send_snmp_credentials: sendCreds,
          prune_hosts: prune,
          prune_after_days: Number(pruneAfter) || 0,
          sync_maintenance: syncMaint,
          write_acknowledgements: writeAcks,
          read_inventory: readInventory,
          adopt_hosts: adopt,
          adopt_site: adopt ? adoptSite : null,
          adopt_role: adopt ? adoptRole : null,
          adopt_device_type: adopt ? adoptType : null,
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
      <FormColumns>
        <FormColumn>
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
              hint="/api_jsonrpc.php is appended"
              value={url}
              onChange={setUrl}
              placeholder="https://zabbix.example.com"
              error={fieldErrors.url}
            />
            <FormText
              label="API token"
              type="password"
              hint={connection?.token_set ? "Set. Blank keeps it." : undefined}
              info="A named API token from Zabbix (Users → API tokens), with an expiry. Never a username and password."
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
            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
            <Field
              label="Engines"
              hint={engineOptions.length ? undefined : "None yet"}
              info="The monitoring engines that read through this connection. Create one of kind Zabbix under Governance → Monitoring engines, then link it here."
              error={fieldErrors.engines}
            >
              <IdMultiSelect
                options={engineOptions}
                value={engineIds}
                onChange={setEngineIds}
                placeholder="Add an engine…"
                searchPlaceholder="Search engines…"
                emptyText="No Zabbix engine."
              />
            </Field>
          </FormSection>

          <FormSection title="Provisioning" card>
            <FormSelect
              label="Provisioning"
              info="Whether Danbyte writes hosts into Zabbix. Review proposes every change for approval; Auto applies them. Reading is never affected."
              value={mode}
              onChange={setMode}
              options={MODES}
              error={fieldErrors.provision_mode}
            />
            {mode !== "off" && (
              <FormSelect
                label="Which devices"
                info="Devices with a Zabbix check are the ones you asked Zabbix to watch - use this when Zabbix is the monitoring engine. Every device the rules match ignores the checks entirely: Danbyte keeps doing its own pinging and discovery, and simply keeps Zabbix's host list in step with the inventory. A device with no address is skipped and counted."
                value={scope}
                onChange={setScope}
                options={SCOPES}
                error={fieldErrors.provision_scope}
              />
            )}
            {mode !== "off" && (
              <>
                <FormCheckbox
                  label="Sync automatically"
                  checked={autoSync}
                  onChange={setAutoSync}
                />
                {autoSync && (
                  <FormText
                    label="Interval"
                    type="number"
                    hint="minutes, 5 to 1440"
                    value={interval}
                    onChange={setInterval}
                    error={fieldErrors.sync_interval_minutes}
                  />
                )}
                <FormCheckbox
                  label="Send SNMP credentials"
                  info="Writes the device's SNMP community or v3 passphrases into Zabbix as secret macros, on hosts Danbyte creates. Off keeps them in Danbyte."
                  checked={sendCreds}
                  onChange={setSendCreds}
                />
                <FormCheckbox
                  label="Remove unwanted hosts"
                  info="Deletes a host Danbyte created once it has been out of scope for the grace period. A host somebody else made is never touched."
                  checked={prune}
                  onChange={setPrune}
                />
                {prune && (
                  <FormText
                    label="Grace period"
                    type="number"
                    hint="days"
                    value={pruneAfter}
                    onChange={setPruneAfter}
                    error={fieldErrors.prune_after_days}
                  />
                )}
              </>
            )}
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Two-way" card>
            <FormCheckbox
              label="Sync maintenance windows"
              info="A confirmed maintenance or outage in Danbyte becomes a Zabbix maintenance period over the hosts this connection has linked. Moving or closing the window follows; a period Danbyte wrote is the only kind it ever removes."
              checked={syncMaint}
              onChange={setSyncMaint}
            />
            <FormCheckbox
              label="Write acknowledgements"
              info="Acknowledging a Danbyte alert that Zabbix raised acknowledges the Zabbix problems behind it, with the operator's name and note. Clearing it clears it there."
              checked={writeAcks}
              onChange={setWriteAcks}
            />
          </FormSection>

          <FormSection title="Inventory" card>
            <FormCheckbox
              label="Read host inventory"
              info="Records what Zabbix's inventory says about a linked device - its name and serial - and shows any disagreement in that device's drift inbox. Nothing is written to the device until somebody accepts it. Rides the host read the sync already makes, so it costs no extra call."
              checked={readInventory}
              onChange={setReadInventory}
            />
          </FormSection>

          <FormSection title="Adoption" card>
            <FormCheckbox
              label="Adopt hosts"
              info="A Zabbix host Danbyte has no device for is offered in the review queue; applying makes the device with the host's name, serial and address. Needs provisioning in Review or Auto - the queue is the same one."
              checked={adopt}
              onChange={setAdopt}
            />
            {adopt && (
              <>
                <FormSelect
                  label="Site"
                  hint="when no host group names one"
                  value={adoptSite}
                  onChange={setAdoptSite}
                  options={asOptions(sites.data?.results)}
                  noneLabel="None"
                  error={fieldErrors.adopt_site}
                />
                <FormSelect
                  label="Role"
                  value={adoptRole}
                  onChange={setAdoptRole}
                  options={asOptions(roles.data?.results)}
                  noneLabel="None"
                  error={fieldErrors.adopt_role}
                />
                <DeviceTypePicker
                  value={adoptType}
                  onChange={setAdoptType}
                  hint="when the inventory model names none"
                />
              </>
            )}
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormSection title="Severity mapping" card>
        <div className="grid gap-3 @md:grid-cols-2">
          {rows.map((row) => (
            <FormSelect
              key={row.value}
              label={row.label}
              info={
                row.value === "0"
                  ? "What each Zabbix severity means for the Danbyte status. Worst wins: one Disaster among a dozen Warnings is a down host."
                  : undefined
              }
              value={effective(row.value)}
              onChange={(v) =>
                setSeverity((prev) => ({ ...prev, [row.value]: v ?? "up" }))
              }
              options={statusOptions}
            />
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
