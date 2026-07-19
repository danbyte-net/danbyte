import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"
import { Plug, Trash2 } from "lucide-react"

import {
  api,
  type LdapDirGroup,
  type LdapGroupMapping,
  type LdapGroupType,
  type LdapSettings,
  type Paginated,
  type RBACGroup,
  type TenantLdapSettings,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormSelect } from "@/components/forms"
import { DataTable, SortHeader } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

const GROUP_TYPES: { value: LdapGroupType; label: string }[] = [
  { value: "ad", label: "Active Directory (nested)" },
  { value: "group_of_names", label: "groupOfNames (OpenLDAP)" },
  { value: "posix", label: "POSIX groups" },
]

/** The API surface a directory page talks to — deployment or tenant. */
export interface LdapEndpoints {
  settings: string
  test: string
  testLogin: string
  browseGroups: string
  mappings: string
  /** react-query cache key prefix (keeps the two tiers separate). */
  cacheKey: string
}

export const DEPLOYMENT_LDAP: LdapEndpoints = {
  settings: "/api/deployment/ldap/",
  test: "/api/deployment/ldap/test/",
  testLogin: "/api/deployment/ldap/test-login/",
  browseGroups: "/api/deployment/ldap/groups/",
  mappings: "/api/ldap-group-mappings/",
  cacheKey: "deployment-ldap",
}

export const TENANT_LDAP: LdapEndpoints = {
  settings: "/api/tenant-settings/ldap/",
  test: "/api/tenant-settings/ldap/test/",
  testLogin: "/api/tenant-settings/ldap/test-login/",
  browseGroups: "/api/tenant-settings/ldap/groups/",
  mappings: "/api/tenant-ldap-group-mappings/",
  cacheKey: "tenant-ldap",
}

type AnyLdap = LdapSettings & Partial<TenantLdapSettings>

/** The full directory admin surface — connection form, dry-run login, group
 * mappings — parameterized by endpoints so the deployment page and the
 * per-tenant override page render the exact same UI. `tenantMode` adds the
 * override toggle + login-domain routing fields. */
export function LdapDirectory({
  endpoints,
  tenantMode = false,
}: {
  endpoints: LdapEndpoints
  tenantMode?: boolean
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: [endpoints.cacheKey],
    queryFn: () => api<AnyLdap>(endpoints.settings),
  })

  const [form, setForm] = useState<AnyLdap | null>(null)
  const [password, setPassword] = useState("")
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<AnyLdap>(endpoints.settings, {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          ...(password ? { ldap_bind_password: password } : {}),
        }),
      }),
    onSuccess: (data) => {
      setForm(data)
      setPassword("")
      qc.setQueryData([endpoints.cacheKey], data)
      toast.success("Directory settings saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  const test = useMutation({
    mutationFn: () => api<{ ok: boolean }>(endpoints.test, { method: "POST" }),
    onSuccess: () => toast.success("Connected and bound successfully"),
    onError: (err) => apiErrorToast(err),
  })

  if (q.isError) return <QueryError error={q.error} />
  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>

  const set = <K extends keyof AnyLdap>(k: K, v: AnyLdap[K]) =>
    setForm({ ...form, [k]: v })

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">
            Directory (LDAP / Active Directory)
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {tenantMode
              ? "This tenant's own directory. Logins routed here auto-provision accounts owned by this tenant and grant membership to it only."
              : "Let users sign in with their directory credentials. First login auto-provisions a Danbyte account; group access is granted through the mappings below. Local accounts keep working either way."}
          </p>
        </div>

        {tenantMode && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 text-sm">
            <Checkbox
              checked={!!form.override_ldap}
              onCheckedChange={(v) => set("override_ldap", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="font-medium">
                Use this tenant's own directory
              </span>
              <span className="text-[11px] text-muted-foreground">
                When off, logins only try the deployment directory (if any).
              </span>
            </span>
          </label>
        )}

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 text-sm">
          <Checkbox
            checked={form.ldap_enabled}
            onCheckedChange={(v) => set("ldap_enabled", !!v)}
            className="mt-0.5"
          />
          <span className="flex flex-col">
            <span className="font-medium">Enable directory authentication</span>
            <span className="text-[11px] text-muted-foreground">
              When off, the directory is ignored entirely.
            </span>
          </span>
        </label>

        <div className="grid gap-4">
          <Field
            label="Server URI"
            hint="ldaps:// is encrypted; ldap:// is plaintext"
          >
            <Input
              placeholder="ldaps://dc01.acme.local"
              value={form.ldap_server_uri}
              onChange={(e) => set("ldap_server_uri", e.target.value)}
              className="font-mono"
            />
          </Field>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={form.ldap_start_tls}
                onCheckedChange={(v) => set("ldap_start_tls", !!v)}
              />
              StartTLS (for ldap://)
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={form.ldap_ignore_cert}
                onCheckedChange={(v) => set("ldap_ignore_cert", !!v)}
              />
              Ignore TLS certificate (lab only)
            </label>
          </div>

          {tenantMode && (
            <Field
              label="Login domains"
              hint='Comma-separated. A "user@corp.com" login routes straight to this directory and stores the full user@domain username (collision-proof).'
            >
              <Input
                placeholder="corp.com, acme.com"
                value={(form.ldap_login_domains ?? []).join(", ")}
                onChange={(e) =>
                  set(
                    "ldap_login_domains",
                    e.target.value
                      .split(",")
                      .map((d) => d.trim())
                      .filter(Boolean)
                  )
                }
                className="font-mono"
              />
            </Field>
          )}

          <Field
            label="Bind DN"
            hint="Service account used to search the directory"
          >
            <Input
              placeholder="CN=danbyte,OU=Service,DC=acme,DC=local"
              value={form.ldap_bind_dn}
              onChange={(e) => set("ldap_bind_dn", e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            label="Bind password"
            hint={
              form.bind_password_set ? "Saved — leave blank to keep" : undefined
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={form.bind_password_set ? "••••••••" : ""}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field label="User search base">
            <Input
              placeholder="OU=Users,DC=acme,DC=local"
              value={form.ldap_user_search_base}
              onChange={(e) => set("ldap_user_search_base", e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="User search filter" hint="%(user)s is the login name">
            <Input
              value={form.ldap_user_search_filter}
              onChange={(e) => set("ldap_user_search_filter", e.target.value)}
              className="font-mono"
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="First name attr">
              <Input
                value={form.ldap_attr_first_name}
                onChange={(e) => set("ldap_attr_first_name", e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Last name attr">
              <Input
                value={form.ldap_attr_last_name}
                onChange={(e) => set("ldap_attr_last_name", e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Email attr">
              <Input
                value={form.ldap_attr_email}
                onChange={(e) => set("ldap_attr_email", e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>

          <Field
            label="Group search base"
            hint="Where to look for groups to map"
          >
            <Input
              placeholder="OU=Groups,DC=acme,DC=local"
              value={form.ldap_group_search_base}
              onChange={(e) => set("ldap_group_search_base", e.target.value)}
              className="font-mono"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <FormSelect
              label="Group type"
              value={form.ldap_group_type}
              onChange={(v) =>
                set("ldap_group_type", (v as LdapGroupType) ?? "ad")
              }
              options={GROUP_TYPES}
            />
            <Field label="Require group" hint="Optional — DN a user must be in">
              <Input
                placeholder="CN=Danbyte Users,…"
                value={form.ldap_require_group}
                onChange={(e) => set("ldap_require_group", e.target.value)}
                className="font-mono"
              />
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Spinner className="size-4" />}
            Save settings
          </Button>
          <Button
            variant="outline"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            {test.isPending ? (
              <Spinner className="size-4" />
            ) : (
              <Plug className="size-4" />
            )}
            Test connection
          </Button>
        </div>
      </section>

      <TestLogin endpoints={endpoints} />

      <GroupMappings endpoints={endpoints} tenantMode={tenantMode} />
    </div>
  )
}

// ─── Dry-run a directory login (issue #152) ─────────────────────────────────
function TestLogin({ endpoints }: { endpoints: LdapEndpoints }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [result, setResult] = useState<{
    ok: boolean
    error?: string
    username?: string
    groups?: string[]
    trace?: string[]
  } | null>(null)

  const run = useMutation({
    mutationFn: () =>
      api<{
        ok: boolean
        error?: string
        username?: string
        groups?: string[]
        trace?: string[]
      }>(endpoints.testLogin, {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    onSuccess: (data) => {
      setResult(data)
      if (data.ok) toast.success(`Authenticated as ${data.username}`)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Test a user login</h2>
      <p className="text-[13px] text-muted-foreground">
        Dry-runs the real directory login and shows the full trace — use it when
        a user can sign in to AD but not to Danbyte. Nothing is persisted.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="sAMAccountName"
            className="font-mono"
            autoComplete="off"
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Button
          variant="outline"
          onClick={() => run.mutate()}
          disabled={run.isPending || !username || !password}
        >
          {run.isPending ? (
            <Spinner className="size-4" />
          ) : (
            <Plug className="size-4" />
          )}
          Test login
        </Button>
      </div>
      {result && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          {result.ok ? (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              Authenticated as{" "}
              <span className="font-mono">{result.username}</span>
              {result.groups && result.groups.length > 0 ? (
                <> — mapped groups: {result.groups.join(", ")}</>
              ) : (
                <> — no Danbyte groups mapped (check the mappings below)</>
              )}
            </p>
          ) : (
            <p className="text-sm text-destructive">{result.error}</p>
          )}
          {result.trace && result.trace.length > 0 && (
            <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {result.trace.join("\n")}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}

// ─── Directory group → Danbyte group mappings ───────────────────────────────
function GroupMappings({
  endpoints,
  tenantMode,
}: {
  endpoints: LdapEndpoints
  tenantMode: boolean
}) {
  const qc = useQueryClient()
  const [dn, setDn] = useState("")
  const [cn, setCn] = useState("")
  const [groupId, setGroupId] = useState<string | null>(null)
  const [browsed, setBrowsed] = useState<LdapDirGroup[] | null>(null)

  const mappingsKey = [endpoints.cacheKey, "mappings"]
  const mappings = useQuery({
    queryKey: mappingsKey,
    queryFn: () => api<Paginated<LdapGroupMapping>>(endpoints.mappings),
  })
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
  })

  const browse = useMutation({
    mutationFn: () => api<{ groups: LdapDirGroup[] }>(endpoints.browseGroups),
    onSuccess: (r) => {
      setBrowsed(r.groups)
      if (!r.groups.length)
        toast.message("No groups found under the search base")
    },
    onError: (err) => apiErrorToast(err),
  })

  const add = useMutation({
    mutationFn: () =>
      api<LdapGroupMapping>(endpoints.mappings, {
        method: "POST",
        body: JSON.stringify({
          ldap_group_dn: dn.trim(),
          ldap_group_cn: cn.trim(),
          group_id: Number(groupId),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mappingsKey })
      setDn("")
      setCn("")
      setGroupId(null)
      toast.success("Mapping added")
    },
    onError: (err) => apiErrorToast(err),
  })

  const del = useMutation({
    mutationFn: (id: number) =>
      api<void>(`${endpoints.mappings}${id}/`, { method: "DELETE" }),
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

  const columns = useMemo<ColumnDef<LdapGroupMapping>[]>(
    () => [
      {
        id: "directoryGroup",
        accessorFn: (m) => m.ldap_group_cn || m.ldap_group_dn,
        header: ({ column }) => (
          <SortHeader column={column} label="Directory group" />
        ),
        cell: ({ row }) => {
          const m = row.original
          return (
            <div>
              <div className="font-medium">{m.ldap_group_cn || "—"}</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {m.ldap_group_dn}
              </div>
            </div>
          )
        },
      },
      {
        id: "group",
        accessorKey: "group_name",
        header: ({ column }) => (
          <SortHeader column={column} label="Danbyte group" />
        ),
        cell: ({ row }) => row.original.group_name,
      },
      {
        id: "actions",
        enableSorting: false,
        enableHiding: false,
        header: () => null,
        cell: ({ row }) => (
          <div className="text-right">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => del.mutate(row.original.id)}
              disabled={del.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ],
    [del]
  )

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Group mappings</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Map a directory group to a Danbyte group. On every login, members of
          the directory group are placed in the mapped Danbyte group (and its
          permissions). Only mapped groups grant access.
          {tenantMode &&
            " Tenant mappings may only target groups whose permissions are narrowed to this tenant."}
        </p>
      </div>

      <DataTable
        data={rows}
        columns={columns}
        tableId={`${endpoints.cacheKey}-mappings`}
        flexColumn="directoryGroup"
        enableExport={false}
      />

      {/* Add a mapping */}
      <div className="grid gap-3 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Add a mapping</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => browse.mutate()}
            disabled={browse.isPending}
          >
            {browse.isPending && <Spinner className="size-4" />}
            Browse directory
          </Button>
        </div>

        {browsed && browsed.length > 0 && (
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-auto">
            {browsed.map((g) => (
              <button
                key={g.dn}
                type="button"
                title={g.dn}
                onClick={() => {
                  setDn(g.dn)
                  setCn(g.cn)
                }}
                className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] hover:bg-muted/70"
              >
                {g.cn || g.dn}
              </button>
            ))}
          </div>
        )}

        <Field label="Directory group DN">
          <Input
            placeholder="CN=Network Admins,OU=Groups,DC=acme,DC=local"
            value={dn}
            onChange={(e) => setDn(e.target.value)}
            className="font-mono"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Display name (optional)">
            <Input value={cn} onChange={(e) => setCn(e.target.value)} />
          </Field>
          <FormSelect
            label="Danbyte group"
            value={groupId}
            onChange={setGroupId}
            options={groupOptions}
            placeholder="Pick a group"
          />
        </div>
        <div>
          <Button
            onClick={() => add.mutate()}
            disabled={add.isPending || !dn.trim() || !groupId}
          >
            Add mapping
          </Button>
        </div>
      </div>
    </section>
  )
}
