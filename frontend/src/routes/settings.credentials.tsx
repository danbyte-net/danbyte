import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  SharedCredential,
  SharedCredentialKind,
  SharedCredentialMatches,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
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
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import type { IdOption } from "@/components/cells/id-multi-select"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { Loading } from "@/components/loading"
import {
  buildSharedCredentialColumns,
  SHARED_CREDENTIAL_KINDS as KINDS,
} from "@/components/columns/shared-credential-columns"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormRow,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"

// Shared credentials (#451): one login for every host its scope matches,
// tried after a host's own device credential. The secret is write-only and
// lives in the secret store, as a device credential's does.

export const Route = createFileRoute("/settings/credentials")({
  component: CredentialsSettingsPage,
})

const URL = "/api/monitoring/shared-credentials/"

function CredentialsSettingsPage() {
  const { canDo, isLoading: meLoading } = useMe()
  const canView = canDo("sharedcredential", "view")
  const canAdd = canDo("sharedcredential", "add")
  const canEdit = canDo("sharedcredential", "change")
  const canDelete = canDo("sharedcredential", "delete")
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<SharedCredential | null>(null)
  const [deleting, setDeleting] = useState<SharedCredential | null>(null)

  const list = useQuery({
    queryKey: ["shared-credentials"],
    queryFn: () => api<Paginated<SharedCredential>>(`${URL}?page_size=500`),
    enabled: canView,
  })
  const rows = list.data?.results ?? []
  const columns = useMemo(
    () =>
      buildSharedCredentialColumns({
        onEdit: canEdit ? setEditing : undefined,
        onDelete: canDelete ? setDeleting : undefined,
      }),
    [canEdit, canDelete]
  )

  if (meLoading) return null
  if (!canView)
    return (
      <p className="text-sm text-muted-foreground">
        You don't have permission to view shared credentials.
      </p>
    )
  return (
    <div className="max-w-5xl space-y-4">
      <SettingsHeader title="Credentials">
        Logins shared by every host their scope matches. A host's own device
        credential always comes first.
      </SettingsHeader>
      <SettingsCard
        title="Shared credentials"
        description="Tried in weight order, lowest first."
        layout="plain"
        footer={
          canAdd ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <KeyRound className="h-3.5 w-3.5" /> Add credential
            </Button>
          ) : undefined
        }
      >
        {list.isError ? (
          <QueryError error={list.error} />
        ) : list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <DataTable
            data={rows}
            columns={columns}
            flexColumn="scope"
            tableId="shared-credentials"
            autoColumns={false}
          />
        )}
      </SettingsCard>
      <CredentialDialog
        credential={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
      <DeleteDialog
        credential={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

type Scope = {
  role_ids: string[]
  device_type_ids: string[]
  platform_ids: string[]
  site_ids: string[]
  tag_ids: string[]
}
const EMPTY_SCOPE: Scope = {
  role_ids: [],
  device_type_ids: [],
  platform_ids: [],
  site_ids: [],
  tag_ids: [],
}

function usePicker(key: string, url: string, open: boolean, color = false) {
  return useQuery({
    queryKey: [key, "picker"],
    queryFn: () =>
      apiAll<{ id: string; name?: string; model?: string; color?: string }>(
        url
      ),
    enabled: open,
    select: (d): IdOption[] =>
      d.results.map((o) => ({
        id: o.id,
        name: o.name || o.model || "",
        ...(color ? { color: o.color || null } : {}),
      })),
  })
}

function useOptions(open: boolean) {
  const roles = usePicker(
    "device-roles",
    "/api/device-roles/?picker=1",
    open,
    true
  )
  const deviceTypes = usePicker(
    "device-types",
    "/api/device-types/?picker=1",
    open
  )
  const platforms = usePicker("platforms", "/api/platforms/?picker=1", open)
  const sites = usePicker("sites", "/api/sites/?picker=1", open)
  const tags = usePicker("tags", "/api/tags/", open, true)
  return { roles, deviceTypes, platforms, sites, tags }
}

function CredentialDialog({
  credential,
  open,
  onOpenChange,
}: {
  credential: SharedCredential | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const isEdit = !!credential
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState("")
  const [kind, setKind] = useState<SharedCredentialKind>("ssh_key")
  const [username, setUsername] = useState("")
  const [port, setPort] = useState("")
  const [password, setPassword] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [passphrase, setPassphrase] = useState("")
  const [certificate, setCertificate] = useState("")
  const [weight, setWeight] = useState("100")
  const [enabled, setEnabled] = useState(true)
  const [fallThrough, setFallThrough] = useState(false)
  const [devices, setDevices] = useState(true)
  const [vms, setVms] = useState(true)
  const [allHosts, setAllHosts] = useState(false)
  const [scope, setScope] = useState<Scope>(EMPTY_SCOPE)
  const [description, setDescription] = useState("")
  const opts = useOptions(open)

  useEffect(() => {
    if (!open) return
    reset()
    const c = credential
    setName(c?.name ?? "")
    setKind(c?.kind ?? "ssh_key")
    setUsername(c?.username ?? "")
    setPort(c?.port != null ? String(c.port) : "")
    setPassword("")
    setPrivateKey("")
    setPassphrase("")
    setCertificate("")
    setWeight(String(c?.weight ?? 100))
    setEnabled(c?.enabled ?? true)
    setFallThrough(c?.fall_through ?? false)
    setDevices(c?.applies_to_devices ?? true)
    setVms(c?.applies_to_vms ?? true)
    setAllHosts(c?.all_hosts ?? false)
    setScope(
      c
        ? {
            role_ids: c.role_ids,
            device_type_ids: c.device_type_ids,
            platform_ids: c.platform_ids,
            site_ids: c.site_ids,
            tag_ids: c.tag_ids,
          }
        : EMPTY_SCOPE
    )
    setDescription(c?.description ?? "")
  }, [open, credential, reset])

  const scopeBody = {
    ...scope,
    all_hosts: allHosts,
    applies_to_devices: devices,
    applies_to_vms: vms,
  }
  const preview = useQuery({
    queryKey: ["shared-credentials", "preview", scopeBody],
    queryFn: () =>
      api<SharedCredentialMatches>(`${URL}preview/`, {
        method: "POST",
        body: JSON.stringify(scopeBody),
      }),
    enabled: open,
    placeholderData: (prev) => prev,
  })

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        username: username.trim(),
        port: port.trim() === "" ? null : Number(port),
        weight: weight.trim() === "" ? 100 : Number(weight),
        enabled,
        fall_through: fallThrough,
        description: description.trim(),
        ...scopeBody,
      }
      if (kind === "ssh_key" || kind === "winrm_cert") {
        if (privateKey) body.private_key = privateKey
        if (passphrase) body.passphrase = passphrase
        if (kind === "winrm_cert" && certificate) body.certificate = certificate
      } else if (password) body.password = password
      return api<SharedCredential>(isEdit ? `${URL}${credential.id}/` : URL, {
        method: isEdit ? "PATCH" : "POST",
        body: JSON.stringify(body),
      })
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["shared-credentials"] })
      toast.success(isEdit ? `Updated ${c.name}` : `Created ${c.name}`)
      onOpenChange(false)
    },
    onError: (err) => {
      if (handleApiError(err) !== null) apiErrorToast(err)
    },
  })

  const set = (k: keyof Scope) => (v: string[]) =>
    setScope((s) => ({ ...s, [k]: v }))
  const keep =
    isEdit && credential.secret_set ? "Saved - leave empty to keep" : ""
  const m = preview.data?.count
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${credential.name}` : "Add shared credential"}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <FormRow>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              error={fieldErrors.name}
            />
            <FormSelect
              label="Kind"
              value={kind}
              onChange={(v) => v && setKind(v as SharedCredentialKind)}
              options={KINDS}
              error={fieldErrors.kind}
            />
          </FormRow>
          <FormRow>
            <FormText
              label="User name"
              required={kind === "ssh_key" || kind === "ssh_password"}
              value={username}
              onChange={setUsername}
              error={fieldErrors.username}
            />
            <FormText
              label="Port"
              type="number"
              value={port}
              onChange={setPort}
              placeholder="22"
              error={fieldErrors.port}
            />
          </FormRow>
          {kind === "ssh_key" || kind === "winrm_cert" ? (
            <>
              {kind === "winrm_cert" && (
                <FormTextarea
                  label="Client certificate"
                  rows={4}
                  value={certificate}
                  onChange={setCertificate}
                  placeholder={keep || "-----BEGIN CERTIFICATE-----"}
                  error={fieldErrors.certificate}
                  info="For WinRM over HTTPS. Write-only, like the key."
                />
              )}
              <FormTextarea
                label="Private key"
                rows={4}
                value={privateKey}
                onChange={setPrivateKey}
                placeholder={keep || "-----BEGIN OPENSSH PRIVATE KEY-----"}
                error={fieldErrors.private_key}
                info="Write-only: stored in the secret store, never shown again."
              />
              <FormText
                label="Passphrase"
                type="password"
                value={passphrase}
                onChange={setPassphrase}
                placeholder={keep}
                error={fieldErrors.passphrase}
              />
            </>
          ) : (
            <FormText
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder={keep}
              error={fieldErrors.password}
              info="Write-only: stored in the secret store, never shown again."
            />
          )}
          <Field
            label="Scope"
            group
            error={fieldErrors.site_ids}
            info="A host matches when it has one of the picked values in every list you fill in. Empty lists match nothing, unless All hosts is on."
          >
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <FormCheckbox
                  label="Devices"
                  checked={devices}
                  onChange={setDevices}
                />
                <FormCheckbox
                  label="Virtual machines"
                  checked={vms}
                  onChange={setVms}
                />
                <FormCheckbox
                  label="All hosts"
                  checked={allHosts}
                  onChange={setAllHosts}
                />
              </div>
              {!allHosts && (
                <>
                  <ScopeSelect
                    label="Roles"
                    options={opts.roles.data}
                    value={scope.role_ids}
                    onChange={set("role_ids")}
                  />
                  <ScopeSelect
                    label="Device types"
                    options={opts.deviceTypes.data}
                    value={scope.device_type_ids}
                    onChange={set("device_type_ids")}
                  />
                  <ScopeSelect
                    label="Platforms"
                    options={opts.platforms.data}
                    value={scope.platform_ids}
                    onChange={set("platform_ids")}
                  />
                  <ScopeSelect
                    label="Sites"
                    options={opts.sites.data}
                    value={scope.site_ids}
                    onChange={set("site_ids")}
                  />
                  <ScopeSelect
                    label="Tags"
                    options={opts.tags.data}
                    value={scope.tag_ids}
                    onChange={set("tag_ids")}
                  />
                </>
              )}
              <p className="text-xs text-muted-foreground">
                {m === undefined
                  ? "Matches …"
                  : `Matches ${m} ${m === 1 ? "host" : "hosts"}`}
              </p>
            </div>
          </Field>
          <FormRow>
            <FormText
              label="Weight"
              type="number"
              value={weight}
              onChange={setWeight}
              error={fieldErrors.weight}
              info="Lower is tried first. On a tie, the scope that names more wins, then the name."
            />
            <Field label="Options">
              <div className="flex flex-col gap-2 pt-1">
                <FormCheckbox
                  label="Enabled"
                  checked={enabled}
                  onChange={setEnabled}
                />
                <FormCheckbox
                  label="Try the next if refused"
                  checked={fallThrough}
                  onChange={setFallThrough}
                  info="Off by default: trying one password after another against the same account is how accounts get locked out. At most three credentials are tried for one host."
                />
              </div>
            </Field>
          </FormRow>
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save" : "Create"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ScopeSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: IdOption[] | undefined
  value: string[]
  onChange: (v: string[]) => void
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <IdMultiSelect
        options={options ?? []}
        value={value}
        onChange={onChange}
        placeholder="Any"
        searchPlaceholder={`Search ${label.toLowerCase()}…`}
      />
    </div>
  )
}

function DeleteDialog({
  credential,
  onOpenChange,
}: {
  credential: SharedCredential | null
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`${URL}${credential!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${credential!.name}`)
      qc.invalidateQueries({ queryKey: ["shared-credentials"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!credential} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {credential?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Hosts it matched fall back to their own credential, or none.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
