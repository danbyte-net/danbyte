import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"
import { Check, KeyRound, Plus, Trash2 } from "lucide-react"

import { api } from "@/lib/api"
import type {
  IdentityProvider,
  IdentityProviderWritePayload,
  Paginated,
  RBACGroup,
  SsoGroupMapping,
  SsoProtocol,
  TenantPicker,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { DataTable, SortHeader } from "@/components/data-table"
import { RowActions } from "@/components/row-actions"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { CopyButton } from "@/components/kv-card"
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
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export const Route = createFileRoute("/settings/sso")({
  component: SsoSettingsPage,
})

const PROTOCOL_OPTIONS: { value: SsoProtocol; label: string }[] = [
  { value: "oidc", label: "OpenID Connect (OIDC)" },
  { value: "saml", label: "SAML 2.0" },
]

function protocolLabel(p: SsoProtocol): string {
  return p === "saml" ? "SAML" : "OIDC"
}

/** A read-only URL row with a copy button — the values to register at the IdP. */
function ReadonlyUrl({
  label,
  hint,
  value,
}: {
  label: string
  hint: string
  value: string
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton value={value} />
      </div>
    </Field>
  )
}

function SsoSettingsPage() {
  // Deployment-wide auth config — gate here (the backend also enforces it; the
  // hidden nav link is only a UI convenience).
  const { canManageDeployment, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment)
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage identity providers.
      </p>
    )
  return <IdentityProviders />
}

function IdentityProviders() {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<IdentityProvider | null>(null)
  const [deleting, setDeleting] = useState<IdentityProvider | null>(null)

  // Keep the tenant map handy so the list can name a provider's tenant scope.
  const tenantsQ = useQuery({
    queryKey: ["tenants-picker"],
    queryFn: () => api<Paginated<TenantPicker>>("/api/tenants/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const tenantName = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of tenantsQ.data?.results ?? []) m.set(t.id, t.name)
    return m
  }, [tenantsQ.data])

  const list = useQuery({
    queryKey: ["identity-providers"],
    queryFn: () =>
      api<Paginated<IdentityProvider>>(
        "/api/identity-providers/?page_size=200"
      ),
  })
  const rows = list.data?.results ?? []

  const columns = useMemo<ColumnDef<IdentityProvider>[]>(
    () =>
      buildColumns({
        tenantName,
        onEdit: setEditing,
        onDelete: setDeleting,
      }),
    [tenantName]
  )

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-sm font-semibold">Identity providers (SSO)</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Let users sign in through an external identity provider (OIDC or
          SAML). Enabled providers appear as "Sign in with…" buttons on the
          login page. Local and directory logins keep working alongside SSO.
        </p>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add provider
        </Button>
      </div>

      {list.isError ? (
        <QueryError error={list.error} />
      ) : list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No identity providers yet.">
          Add one to offer single sign-on on the login page.
        </EmptyState>
      ) : (
        <DataTable data={rows} columns={columns} flexColumn="name" />
      )}

      <ProviderDialog
        provider={editing}
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      />
      <DeleteDialog
        provider={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

function buildColumns({
  tenantName,
  onEdit,
  onDelete,
}: {
  tenantName: Map<string, string>
  onEdit: (p: IdentityProvider) => void
  onDelete: (p: IdentityProvider) => void
}): ColumnDef<IdentityProvider>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-2 font-medium">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          {row.original.name}
        </span>
      ),
    },
    {
      id: "protocol",
      accessorKey: "protocol",
      header: "Protocol",
      cell: ({ row }) => (
        <Badge variant="secondary">{protocolLabel(row.original.protocol)}</Badge>
      ),
    },
    {
      id: "enabled",
      accessorKey: "enabled",
      header: "Status",
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="outline">Disabled</Badge>
        ),
    },
    {
      id: "tenant",
      header: "Scope",
      cell: ({ row }) => {
        const t = row.original.tenant
        return t ? (
          <span className="text-xs">{tenantName.get(t) ?? "One tenant"}</span>
        ) : (
          <span className="text-xs text-muted-foreground">Deployment-wide</span>
        )
      },
    },
    {
      id: "jit",
      accessorKey: "jit_provisioning",
      header: "JIT",
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.jit_provisioning ? "On" : "Off"}
        </Badge>
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          onEdit={() => onEdit(row.original)}
          onDelete={() => onDelete(row.original)}
        />
      ),
    },
  ]
}

// ─── Create / edit ──────────────────────────────────────────────────────────
function ProviderDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: IdentityProvider | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const isEdit = !!provider
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [protocol, setProtocol] = useState<SsoProtocol>("oidc")
  const [enabled, setEnabled] = useState(true)
  const [tenant, setTenant] = useState<string | null>(null)
  const [defaultTenant, setDefaultTenant] = useState<string | null>(null)
  const [defaultGroup, setDefaultGroup] = useState<number | null>(null)
  const [oidcIssuer, setOidcIssuer] = useState("")
  const [oidcClientId, setOidcClientId] = useState("")
  const [oidcScopes, setOidcScopes] = useState("openid email profile")
  const [samlEntityId, setSamlEntityId] = useState("")
  const [samlSsoUrl, setSamlSsoUrl] = useState("")
  const [samlX509, setSamlX509] = useState("")
  const [claimEmail, setClaimEmail] = useState("")
  const [claimUsername, setClaimUsername] = useState("")
  const [claimFirstName, setClaimFirstName] = useState("")
  const [claimLastName, setClaimLastName] = useState("")
  const [claimGroups, setClaimGroups] = useState("")
  const [jit, setJit] = useState(true)
  const [clientSecret, setClientSecret] = useState("")

  // Reseed on open (edit → prefill, add → blanks/defaults).
  useEffect(() => {
    if (!open) return
    setName(provider?.name ?? "")
    setSlug(provider?.slug ?? "")
    setProtocol(provider?.protocol ?? "oidc")
    setEnabled(provider?.enabled ?? true)
    setTenant(provider?.tenant ?? null)
    setDefaultTenant(provider?.default_tenant ?? null)
    setDefaultGroup(provider?.default_group ?? null)
    setOidcIssuer(provider?.oidc_issuer ?? "")
    setOidcClientId(provider?.oidc_client_id ?? "")
    setOidcScopes(provider?.oidc_scopes ?? "openid email profile")
    setSamlEntityId(provider?.saml_idp_entity_id ?? "")
    setSamlSsoUrl(provider?.saml_idp_sso_url ?? "")
    setSamlX509(provider?.saml_idp_x509 ?? "")
    setClaimEmail(provider?.claim_email ?? "")
    setClaimUsername(provider?.claim_username ?? "")
    setClaimFirstName(provider?.claim_first_name ?? "")
    setClaimLastName(provider?.claim_last_name ?? "")
    setClaimGroups(provider?.claim_groups ?? "")
    setJit(provider?.jit_provisioning ?? true)
    setClientSecret("")
    reset()
  }, [open, provider, reset])

  const tenantsQ = useQuery({
    queryKey: ["tenants-picker"],
    queryFn: () => api<Paginated<TenantPicker>>("/api/tenants/?picker=1"),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const tenantOptions = (tenantsQ.data?.results ?? []).map((t) => ({
    value: t.id,
    label: t.name,
  }))
  const groupsQ = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const groupOptions = (groupsQ.data?.results ?? []).map((g) => ({
    value: String(g.id),
    label: g.name,
  }))

  const mutation = useMutation({
    mutationFn: () => {
      const payload: IdentityProviderWritePayload = {
        name: name.trim(),
        slug: slug.trim(),
        protocol,
        enabled,
        tenant,
        default_tenant: defaultTenant,
        default_group: defaultGroup,
        oidc_issuer: oidcIssuer.trim(),
        oidc_client_id: oidcClientId.trim(),
        oidc_scopes: oidcScopes.trim(),
        saml_idp_entity_id: samlEntityId.trim(),
        saml_idp_sso_url: samlSsoUrl.trim(),
        saml_idp_x509: samlX509.trim(),
        claim_email: claimEmail.trim(),
        claim_username: claimUsername.trim(),
        claim_first_name: claimFirstName.trim(),
        claim_last_name: claimLastName.trim(),
        claim_groups: claimGroups.trim(),
        jit_provisioning: jit,
      }
      // Only send the secret when the admin actually typed one — a blank field
      // on edit means "keep the stored secret".
      if (clientSecret) payload.client_secret = clientSecret
      if (isEdit)
        return api<IdentityProvider>(
          `/api/identity-providers/${provider.id}/`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      return api<IdentityProvider>("/api/identity-providers/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["identity-providers"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${provider.name}` : "Add identity provider"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              placeholder="Entra ID"
              error={fieldErrors.name}
            />
            <FormText
              label="Slug"
              required
              mono
              value={slug}
              onChange={setSlug}
              placeholder="entra"
              hint="URL-safe; keep it stable once set"
              error={fieldErrors.slug}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormSelect
              label="Protocol"
              value={protocol}
              onChange={(v) => setProtocol((v ?? "oidc") as SsoProtocol)}
              options={PROTOCOL_OPTIONS}
              error={fieldErrors.protocol}
            />
            <FormSelect
              label="Tenant"
              value={tenant}
              onChange={setTenant}
              options={tenantOptions}
              noneLabel="Deployment-wide"
              hint="Blank = every tenant may use it"
              error={fieldErrors.tenant}
            />
          </div>

          {protocol === "oidc" ? (
            <div className="grid gap-4 rounded-lg border border-border bg-card p-3">
              <span className="text-xs font-medium">OpenID Connect</span>
              <FormText
                label="Issuer URL"
                mono
                value={oidcIssuer}
                onChange={setOidcIssuer}
                placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
                hint="Base URL for discovery (.well-known/openid-configuration)"
                error={fieldErrors.oidc_issuer}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <FormText
                  label="Client ID"
                  mono
                  value={oidcClientId}
                  onChange={setOidcClientId}
                  error={fieldErrors.oidc_client_id}
                />
                <FormText
                  label="Scopes"
                  mono
                  value={oidcScopes}
                  onChange={setOidcScopes}
                  placeholder="openid email profile"
                  error={fieldErrors.oidc_scopes}
                />
              </div>
              <Field
                label="Client secret"
                hint={
                  isEdit && provider.client_secret_set
                    ? "Leave blank to keep the current secret"
                    : "Stored encrypted; shown only once"
                }
                error={fieldErrors.client_secret}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    provider?.client_secret_set ? "••••••••" : "Client secret"
                  }
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                {provider?.client_secret_set && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3 w-3" /> Secret set
                  </span>
                )}
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 rounded-lg border border-border bg-card p-3">
              <span className="text-xs font-medium">SAML 2.0</span>
              <FormText
                label="IdP entity ID"
                mono
                value={samlEntityId}
                onChange={setSamlEntityId}
                error={fieldErrors.saml_idp_entity_id}
              />
              <FormText
                label="IdP SSO URL"
                mono
                value={samlSsoUrl}
                onChange={setSamlSsoUrl}
                error={fieldErrors.saml_idp_sso_url}
              />
              <FormTextarea
                label="IdP X.509 certificate"
                rows={4}
                value={samlX509}
                onChange={setSamlX509}
                placeholder="-----BEGIN CERTIFICATE-----"
                error={fieldErrors.saml_idp_x509}
              />
            </div>
          )}

          {/* Read-only URLs to register at the IdP — differ by protocol. */}
          {isEdit && protocol === "oidc" && provider.callback_url && (
            <ReadonlyUrl
              label="Callback URL"
              hint="Register this as the redirect URI at your IdP"
              value={provider.callback_url}
            />
          )}
          {isEdit && protocol === "saml" && (
            <div className="grid gap-3">
              <ReadonlyUrl
                label="ACS / Reply URL"
                hint="Register as the Assertion Consumer Service (Reply URL) at your IdP"
                value={provider.acs_url}
              />
              <ReadonlyUrl
                label="SP Identifier (Entity ID)"
                hint="Register as the SP Identifier / Entity ID at your IdP"
                value={provider.sp_entity_id}
              />
              <ReadonlyUrl
                label="SP metadata URL"
                hint="Some IdPs can import SP config from this URL"
                value={provider.metadata_url}
              />
            </div>
          )}

          <div className="grid gap-4 rounded-lg border border-border bg-card p-3">
            <span className="text-xs font-medium">Claim mapping</span>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormText
                label="Email claim"
                mono
                value={claimEmail}
                onChange={setClaimEmail}
                placeholder="email"
                error={fieldErrors.claim_email}
              />
              <FormText
                label="Username claim"
                mono
                value={claimUsername}
                onChange={setClaimUsername}
                placeholder="preferred_username"
                error={fieldErrors.claim_username}
              />
              <FormText
                label="First name claim"
                mono
                value={claimFirstName}
                onChange={setClaimFirstName}
                placeholder="given_name"
                error={fieldErrors.claim_first_name}
              />
              <FormText
                label="Last name claim"
                mono
                value={claimLastName}
                onChange={setClaimLastName}
                placeholder="family_name"
                error={fieldErrors.claim_last_name}
              />
            </div>
            <FormText
              label="Groups claim"
              mono
              value={claimGroups}
              onChange={setClaimGroups}
              placeholder="groups"
              hint="Map its values to groups below (after saving)"
              error={fieldErrors.claim_groups}
            />
          </div>

          <FormSelect
            label="Default tenant"
            value={defaultTenant}
            onChange={setDefaultTenant}
            options={tenantOptions}
            noneLabel="None"
            hint="For JIT users with no other tenant"
            error={fieldErrors.default_tenant}
          />

          <FormSelect
            label="Default group"
            value={defaultGroup != null ? String(defaultGroup) : null}
            onChange={(v) => setDefaultGroup(v ? Number(v) : null)}
            options={groupOptions}
            noneLabel="None"
            hint="Baseline group every user of this provider gets, so new SSO users aren't left with no access"
            error={fieldErrors.default_group}
          />

          <FormCheckbox
            label="Just-in-time provisioning"
            hint="Off = only pre-created users may sign in."
            checked={jit}
            onChange={setJit}
          />
          <FormCheckbox
            label="Enabled"
            hint="Shown as a Sign in with… button on the login page"
            checked={enabled}
            onChange={setEnabled}
          />

          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Create provider"}
          />
        </form>

        {isEdit && <GroupMappings provider={provider} />}
      </DialogContent>
    </Dialog>
  )
}

// ─── IdP group → Danbyte group mappings (edit mode) ─────────────────────────
function GroupMappings({ provider }: { provider: IdentityProvider }) {
  const qc = useQueryClient()
  const [idpGroup, setIdpGroup] = useState("")
  const [groupId, setGroupId] = useState<string | null>(null)

  const mappingsKey = ["sso-group-mappings", provider.id]
  const mappings = useQuery({
    queryKey: mappingsKey,
    queryFn: () =>
      api<Paginated<SsoGroupMapping>>(
        `/api/sso-group-mappings/?provider=${provider.id}`
      ),
  })
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
    staleTime: 5 * 60_000,
  })

  const add = useMutation({
    mutationFn: () =>
      api<SsoGroupMapping>("/api/sso-group-mappings/", {
        method: "POST",
        body: JSON.stringify({
          provider: provider.id,
          idp_group: idpGroup.trim(),
          group: Number(groupId),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mappingsKey })
      setIdpGroup("")
      setGroupId(null)
      toast.success("Mapping added")
    },
    onError: (err) => apiErrorToast(err),
  })

  const del = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/sso-group-mappings/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mappingsKey })
      toast.success("Mapping removed")
    },
    onError: (err) => apiErrorToast(err),
  })

  const groupOptions = (groups.data?.results ?? []).map((g) => ({
    value: String(g.id),
    label: g.name,
  }))
  const rows = mappings.data?.results ?? []

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 className="text-sm font-semibold">Group mappings</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Place users into a Danbyte group when the IdP asserts a matching
          group. Only mapped groups grant access.
        </p>
      </div>

      {mappings.isError ? (
        <QueryError error={mappings.error} />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No mappings yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {m.idp_group}
              </span>
              <span className="text-muted-foreground">→</span>
              <span className="min-w-0 flex-1 truncate">{m.group_name}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                title="Remove mapping"
                onClick={() => del.mutate(m.id)}
                disabled={del.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">Remove mapping</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 rounded-lg border border-border bg-card p-3">
        <span className="text-xs font-medium">Add a mapping</span>
        <Field
          label="IdP group"
          hint="For Entra ID, the group's object ID"
        >
          <Input
            placeholder="Network Admins"
            value={idpGroup}
            onChange={(e) => setIdpGroup(e.target.value)}
            className="font-mono"
          />
        </Field>
        <FormSelect
          label="Danbyte group"
          value={groupId}
          onChange={setGroupId}
          options={groupOptions}
          placeholder="Pick a group"
        />
        <div>
          <Button
            type="button"
            onClick={() => add.mutate()}
            disabled={add.isPending || !idpGroup.trim() || !groupId}
          >
            {add.isPending && <Spinner className="size-4" />}
            Add mapping
          </Button>
        </div>
      </div>
    </section>
  )
}

// ─── Delete ─────────────────────────────────────────────────────────────────
function DeleteDialog({
  provider,
  onOpenChange,
}: {
  provider: IdentityProvider | null
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/identity-providers/${provider!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${provider!.name}`)
      qc.invalidateQueries({ queryKey: ["identity-providers"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!provider} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {provider?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Users will no longer be able to sign in through this provider. Their
            existing Danbyte accounts are unaffected. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
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
