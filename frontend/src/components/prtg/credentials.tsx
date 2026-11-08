import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  PrtgConnection,
  PrtgCredential,
  PrtgCredentialMode,
  PrtgCredentialPlacement,
  PrtgCredentialSection,
  PrtgCredentialStates,
  PrtgGroups,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  FormCombobox,
  FormFooter,
  FormRow,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"

const KINDS: { value: PrtgCredential["kind"]; label: string }[] = [
  { value: "proxmox", label: "Proxmox API token" },
  { value: "vmware", label: "VMware" },
  { value: "windows_login", label: "Windows login" },
  { value: "ssh", label: "SSH" },
]

/** The PrtgCredential kind (or SNMP) that fills a PRTG settings section. */
export const SECTION_SOURCE: Record<string, string> = {
  snmpversiongroup: "snmp",
  windowsconnection: "windows_login",
  linuxconnection: "ssh",
  vmwareconnection: "vmware",
  "paessler-vmware-vmware_credentials_section": "vmware",
  "paessler-proxmox-credentials_section": "proxmox",
}

export const PLACEMENT_MODES: { value: PrtgCredentialMode; label: string }[] = [
  { value: "inherit", label: "Inherit" },
  { value: "group", label: "Set on the group" },
  { value: "device", label: "Set on the device" },
]

export function usePrtgCredentials(connectionId: string) {
  return useQuery({
    queryKey: ["prtg-credentials", connectionId],
    queryFn: () =>
      apiAll<PrtgCredential>(
        `/api/prtg/credentials/?connection=${connectionId}`
      ),
    enabled: !!connectionId,
  })
}

function useSnmpProfiles(enabled: boolean) {
  return useQuery({
    queryKey: ["snmp-profiles"],
    queryFn: () =>
      apiAll<{ id: string; name: string }>("/api/monitoring/snmp-profiles/"),
    staleTime: 60_000,
    enabled,
  })
}

/** What PRTG has in effect for some credential sections on a probe, group
 * or device, read live. */
export function usePrtgCredentialState(
  connectionId: string,
  target: { objid: string; kind: string } | null,
  sections: string[]
) {
  const key = sections.join(",")
  return useQuery({
    queryKey: ["prtg-credential-state", connectionId, target?.objid, key],
    queryFn: () =>
      api<PrtgCredentialStates>(
        `/api/prtg/connections/${connectionId}/credential-state/?objid=${target?.objid}&kind=${target?.kind}&sections=${encodeURIComponent(key)}`
      ),
    enabled: !!target?.objid && sections.length > 0,
    staleTime: 60_000,
    retry: false,
  })
}

/** Where a profile's (or a policy's) credentials go in PRTG, per settings
 * section its sensors need. */
export function CredentialPlacementEditor({
  connection,
  sections,
  value,
  onChange,
  target,
  allowEmpty,
}: {
  connection: PrtgConnection
  sections: PrtgCredentialSection[]
  value: PrtgCredentialPlacement
  onChange: (next: PrtgCredentialPlacement) => void
  /** Where a device would inherit from: the registration group, layout
   * root or a policy's group. */
  target: { objid: string; path: string } | null
  /** A policy's override: Inherit reads as "the profile's choice". */
  allowEmpty?: boolean
}) {
  const creds = usePrtgCredentials(connection.id)
  const needsSnmp = sections.some((s) => s.section === "snmpversiongroup")
  const snmp = useSnmpProfiles(needsSnmp)
  const groups = useQuery({
    queryKey: ["prtg-groups", connection.id],
    queryFn: () =>
      api<PrtgGroups>(`/api/prtg/groups/?connection=${connection.id}`),
    staleTime: 60_000,
    enabled: !!target?.objid,
  })
  const found = groups.data?.groups.find((g) => g.objid === target?.objid)
  const state = usePrtgCredentialState(
    connection.id,
    target ? { objid: target.objid, kind: found?.kind ?? "group" } : null,
    sections.map((s) => s.section)
  )
  if (sections.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No sensor here needs credentials.
      </p>
    )
  const set = (
    section: string,
    patch: Partial<PrtgCredentialPlacement[string]>
  ) => {
    const next = { ...value }
    const merged: PrtgCredentialPlacement[string] = {
      ...(next[section] ?? { mode: "inherit" }),
      ...patch,
    }
    if (merged.mode === "inherit") delete next[section]
    else next[section] = merged
    onChange(next)
  }
  return (
    <div className="grid gap-3" data-testid="prtg-credential-placement">
      {sections.map((s) => {
        const entry = value[s.section] ?? { mode: "inherit" }
        const source = SECTION_SOURCE[s.section]
        const options =
          source === "snmp"
            ? (snmp.data?.results ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))
            : (creds.data?.results ?? [])
                .filter((c) => c.kind === source)
                .map((c) => ({ value: c.id, label: c.name }))
        const st = state.data?.sections?.[s.section]
        return (
          <div
            key={s.section}
            className="grid gap-2 rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap items-baseline gap-2 text-[13px]">
              <span className="font-medium">{s.label}</span>
              <span className="text-xs text-muted-foreground">
                {s.kinds.join(", ")}
              </span>
            </div>
            <FormRow>
              <FormSelect
                label="Credentials"
                value={entry.mode}
                onChange={(v) =>
                  set(s.section, {
                    mode: (v as PrtgCredentialMode | null) ?? "inherit",
                  })
                }
                options={
                  s.writable
                    ? PLACEMENT_MODES.map((m) =>
                        allowEmpty && m.value === "inherit"
                          ? { ...m, label: "As the profile says" }
                          : m
                      )
                    : PLACEMENT_MODES.slice(0, 1)
                }
              />
              {entry.mode !== "inherit" ? (
                <FormCombobox
                  label={source === "snmp" ? "SNMP profile" : "Use"}
                  value={
                    (source === "snmp"
                      ? entry.snmp_profile
                      : entry.credential) ?? null
                  }
                  onChange={(v) =>
                    set(
                      s.section,
                      source === "snmp"
                        ? { snmp_profile: v ?? undefined }
                        : { credential: v ?? undefined }
                    )
                  }
                  options={options}
                  noneLabel={
                    entry.mode === "device" ? "The object's own" : undefined
                  }
                  searchPlaceholder="Search…"
                  emptyText="None yet."
                />
              ) : (
                <div />
              )}
            </FormRow>
            {entry.mode === "inherit" && target && (
              <InheritanceLine
                loading={state.isLoading}
                set={st?.set ?? null}
                text={st?.text ?? ""}
                error={state.data?.error}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function InheritanceLine({
  loading,
  set,
  text,
  error,
}: {
  loading: boolean
  set: boolean | null
  text: string
  error?: string
}) {
  if (loading)
    return <p className="text-xs text-muted-foreground">Reading PRTG…</p>
  if (error) return <p className="text-xs text-muted-foreground">{error}</p>
  if (set === null || !text) return null
  return set ? (
    <p className="text-xs text-muted-foreground">{text}</p>
  ) : (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      Not set on any group above this device
    </p>
  )
}

/** Logins a profile can place on a PRTG group or device. */
export function PrtgCredentials({
  connection,
  canManage,
}: {
  connection: PrtgConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const creds = usePrtgCredentials(connection.id)
  const [editing, setEditing] = useState<PrtgCredential | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PrtgCredential | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/credentials/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Credential deleted")
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: ["prtg-credentials"] })
    },
    onError: (e) => {
      setDeleting(null)
      apiErrorToast(e)
    },
  })
  const rows = creds.data?.results ?? []
  const columns = useMemo<ColumnDef<PrtgCredential>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "kind",
        accessorKey: "kind_display",
        header: "Kind",
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.kind_display}</Badge>
        ),
      },
      {
        id: "user",
        header: "User",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{loginOf(row.original)}</span>
        ),
      },
      {
        id: "secret",
        header: "Secret",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.password_set ||
          row.original.token_secret_set ||
          row.original.private_key_set ? (
            <Badge variant="success">Set</Badge>
          ) : (
            <Badge variant="warning">Not set</Badge>
          ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => (
                <RowActions
                  onEdit={() => setEditing(row.original)}
                  onDelete={() => setDeleting(row.original)}
                />
              ),
            } as ColumnDef<PrtgCredential>,
          ]
        : []),
    ],
    [canManage]
  )
  return (
    <Section
      title="Credentials"
      count={rows.length}
      actions={
        canManage && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add credential
          </Button>
        )
      }
    >
      {creds.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No credentials">
          A profile can set these on a PRTG group or device.
        </EmptyState>
      ) : (
        <DataTable
          tableId="prtg-credentials"
          data={rows}
          total={creds.data?.count}
          columns={columns}
          flexColumn="user"
        />
      )}
      <Dialog
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.name}` : "Add credential"}
            </DialogTitle>
          </DialogHeader>
          {(adding || !!editing) && (
            <CredentialForm
              connection={connection}
              credential={editing}
              onDone={() => {
                setAdding(false)
                setEditing(null)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "this credential"}?`}
        description="Nothing in PRTG changes."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Section>
  )
}

function loginOf(c: PrtgCredential): string {
  const p = c.params
  if (c.kind === "windows_login")
    return p.domain ? `${p.domain}\\${p.user ?? ""}` : (p.user ?? "")
  if (c.kind === "proxmox") {
    let user = p.user ?? ""
    if (p.realm && !user.includes("@")) user = `${user}@${p.realm}`
    if (p.token_id && !user.includes("!")) user = `${user}!${p.token_id}`
    return user
  }
  return p.user ?? ""
}

function CredentialForm({
  connection,
  credential,
  onDone,
}: {
  connection: PrtgConnection
  credential: PrtgCredential | null
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [name, setName] = useState(credential?.name ?? "")
  const [kind, setKind] = useState<PrtgCredential["kind"]>(
    credential?.kind ?? "proxmox"
  )
  const [user, setUser] = useState(credential?.params.user ?? "")
  const [realm, setRealm] = useState(credential?.params.realm ?? "")
  const [tokenId, setTokenId] = useState(credential?.params.token_id ?? "")
  const [domain, setDomain] = useState(credential?.params.domain ?? "")
  const [port, setPort] = useState(
    credential?.params.port != null ? String(credential.params.port) : ""
  )
  const [password, setPassword] = useState("")
  const [tokenSecret, setTokenSecret] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [description, setDescription] = useState(credential?.description ?? "")
  const keep = credential ? "Set. Blank keeps it." : undefined
  const save = useMutation({
    mutationFn: () =>
      api<PrtgCredential>(
        credential
          ? `/api/prtg/credentials/${credential.id}/`
          : "/api/prtg/credentials/",
        {
          method: credential ? "PATCH" : "POST",
          body: JSON.stringify({
            connection: connection.id,
            name: name.trim(),
            kind,
            description,
            params: {
              user,
              ...(kind === "proxmox" ? { realm, token_id: tokenId } : {}),
              ...(kind === "windows_login" ? { domain } : {}),
              ...(port && kind !== "windows_login"
                ? { port: Number(port) }
                : {}),
            },
            ...(password ? { password } : {}),
            ...(tokenSecret ? { token_secret: tokenSecret } : {}),
            ...(privateKey ? { private_key: privateKey } : {}),
          }),
        }
      ),
    onSuccess: (saved) => {
      toast.success(credential ? `Saved ${saved.name}` : `Added ${saved.name}`)
      void qc.invalidateQueries({ queryKey: ["prtg-credentials"] })
      onDone()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })
  const paramsError = (fieldErrors as Record<string, string | undefined>).params
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="grid gap-4"
    >
      <FormRow>
        <FormText
          label="Name"
          required
          autoFocus={!credential}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormSelect
          label="Kind"
          value={kind}
          onChange={(v) =>
            setKind((v as PrtgCredential["kind"] | null) ?? "proxmox")
          }
          options={KINDS}
        />
      </FormRow>
      {kind === "windows_login" ? (
        <FormRow>
          <FormText label="Domain" value={domain} onChange={setDomain} />
          <FormText
            label="User"
            required
            value={user}
            onChange={setUser}
            error={paramsError}
          />
        </FormRow>
      ) : kind === "proxmox" ? (
        <>
          <FormRow>
            <FormText
              label="User"
              required
              value={user}
              onChange={setUser}
              placeholder="prtg"
              error={paramsError}
            />
            <FormText
              label="Realm"
              value={realm}
              onChange={setRealm}
              placeholder="pve"
            />
          </FormRow>
          <FormRow>
            <FormText
              label="Token ID"
              info="PRTG's Proxmox sensors log in with an API token: user@realm!tokenid and the token secret."
              value={tokenId}
              onChange={setTokenId}
              placeholder="danbyte"
            />
            <FormText
              label="Port"
              type="number"
              value={port}
              onChange={setPort}
              placeholder="8006"
            />
          </FormRow>
          <FormText
            label="Token secret"
            type="password"
            value={tokenSecret}
            onChange={setTokenSecret}
            hint={credential?.token_secret_set ? keep : undefined}
            error={fieldErrors.token_secret}
          />
        </>
      ) : (
        <FormRow>
          <FormText
            label="User"
            required
            value={user}
            onChange={setUser}
            error={paramsError}
          />
          <FormText
            label="Port"
            type="number"
            value={port}
            onChange={setPort}
            placeholder={kind === "ssh" ? "22" : "443"}
          />
        </FormRow>
      )}
      {kind !== "proxmox" && (
        <FormText
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          hint={credential?.password_set ? keep : undefined}
          error={fieldErrors.password}
        />
      )}
      {kind === "ssh" && (
        <FormTextarea
          label="Private key"
          value={privateKey}
          onChange={setPrivateKey}
          rows={4}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          hint={credential?.private_key_set ? keep : undefined}
          error={fieldErrors.private_key}
        />
      )}
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
      />
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={credential ? "Save credential" : "Add credential"}
      />
    </form>
  )
}
