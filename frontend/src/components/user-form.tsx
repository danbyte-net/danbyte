import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type RBACGroup,
  type RBACUser,
  type RBACUserWritePayload,
  type SiteOption,
  type TenantPicker,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
  type CheckOption,
} from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { useMe } from "@/lib/use-me"

export interface UserFormProps {
  user?: RBACUser
  onSaved: (u: RBACUser) => void
  onCancel: () => void
}

export function UserForm({ user, onSaved, onCancel }: UserFormProps) {
  const isEdit = !!user
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [username, setUsername] = useState(user?.username ?? "")
  const [email, setEmail] = useState(user?.email ?? "")
  const [firstName, setFirstName] = useState(user?.first_name ?? "")
  const [lastName, setLastName] = useState(user?.last_name ?? "")
  const [password, setPassword] = useState("")
  // How the new account gets its password. "invite" → email a set-password
  // link (admin never handles the credential, GDPR-friendly); "manual" → admin
  // types one. Defaults to invite for new local accounts.
  const [pwMode, setPwMode] = useState<"invite" | "manual">("invite")
  const [isActive, setIsActive] = useState(user?.is_active ?? true)
  const [isSuperuser, setIsSuperuser] = useState(user?.is_superuser ?? false)
  const [requireMfa, setRequireMfa] = useState(user?.require_mfa ?? false)
  const [authSource, setAuthSource] = useState<"local" | "ldap">(
    user?.auth_source ?? "local"
  )
  const [groupIds, setGroupIds] = useState<number[]>(
    user?.groups.map((g) => g.id) ?? []
  )
  const [tenantIds, setTenantIds] = useState<string[]>(
    user?.tenants.map((t) => t.id) ?? []
  )

  // ── one-click site scoping (create only) ──
  // Defaults on when this tenant runs enhanced site separation — that's when
  // "most new users are local IT" is the likely intent.
  const { siteSeparation } = useMe()
  const [siteScoped, setSiteScoped] = useState(siteSeparation)
  const [siteRoleSites, setSiteRoleSites] = useState<string[]>([])
  const [siteRole, setSiteRole] = useState<"editor" | "viewer">("editor")
  const [siteSilo, setSiteSilo] = useState(false)

  useEffect(() => {
    if (!user) return
    setUsername(user.username)
    setEmail(user.email)
    setFirstName(user.first_name)
    setLastName(user.last_name)
    setPassword("")
    setIsActive(user.is_active)
    setIsSuperuser(user.is_superuser)
    setRequireMfa(user.require_mfa)
    setAuthSource(user.auth_source)
    setGroupIds(user.groups.map((g) => g.id))
    setTenantIds(user.tenants.map((t) => t.id))
    reset()
  }, [user, reset])

  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
  })
  const tenantsQuery = useQuery({
    queryKey: ["tenants", "picker"],
    queryFn: () => api<Paginated<TenantPicker>>("/api/tenants/?picker=1"),
  })
  const sitesQuery = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/?picker=1"),
    enabled: !isEdit,
  })
  const siteOptions: CheckOption<string>[] = (
    sitesQuery.data?.results ?? []
  ).map((s) => ({ value: s.id, label: s.name }))

  const groupOptions: CheckOption<number>[] = (
    groupsQuery.data?.results ?? []
  ).map((g) => ({ value: g.id, label: g.name }))
  const tenantOptions: CheckOption<string>[] = (
    tenantsQuery.data?.results ?? []
  ).map((t) => ({ value: t.id, label: t.name }))

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RBACUserWritePayload = {
        username: username.trim(),
        email: email.trim(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        is_active: isActive,
        is_superuser: isSuperuser,
        set_require_mfa: requireMfa,
        set_auth_source: authSource,
        group_ids: groupIds,
        tenant_ids: tenantIds,
      }
      // Invite mode (local accounts only): no password — backend emails a
      // set-your-own-password link. Manual mode / edit: send the typed password
      // if one was entered.
      const inviting = authSource === "local" && pwMode === "invite"
      if (inviting) payload.send_invite = true
      else if (password.trim()) payload.password = password
      // One-click site scoping (create only): the backend assembles the grants.
      if (!isEdit && siteScoped && siteRoleSites.length > 0) {
        payload.site_role = {
          role: siteRole,
          site_ids: siteRoleSites,
          ...(siteRole === "editor" && siteSilo ? { silo: true } : {}),
        }
      }
      if (isEdit)
        return api<RBACUser>(`/api/users/${user!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<RBACUser>("/api/users/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["users"] })
      qc.invalidateQueries({ queryKey: ["user", saved.id] })
      const invited = !isEdit && authSource === "local" && pwMode === "invite"
      toast.success(
        isEdit
          ? `Updated ${saved.username}`
          : invited
            ? `Invited ${saved.username} — set-password email sent`
            : `Created ${saved.username}`
      )
      onSaved(saved)
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
        // Ticked "site-scoped" but picked no sites → the role would be
        // silently dropped and the user created with NO permissions.
        if (!isEdit && siteScoped && siteRoleSites.length === 0) {
          toast.error("Pick at least one site, or untick site-scoped access.")
          return
        }
        mutation.mutate()
      }}
      className="grid max-w-2xl gap-4"
    >
      <div className="grid grid-cols-2 gap-4">
        <FormText
          label="Username"
          required
          autoFocus={!isEdit}
          mono
          value={username}
          onChange={setUsername}
          error={fieldErrors.username}
        />
        <FormText
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          error={fieldErrors.email}
        />
        <FormText
          label="First name"
          value={firstName}
          onChange={setFirstName}
          error={fieldErrors.first_name}
        />
        <FormText
          label="Last name"
          value={lastName}
          onChange={setLastName}
          error={fieldErrors.last_name}
        />
      </div>

      <FormSelect
        label="Authentication"
        value={authSource}
        onChange={(v) => setAuthSource(v as "local" | "ldap")}
        options={[
          { value: "local", label: "Local password" },
          { value: "ldap", label: "LDAP / directory" },
        ]}
        hint={
          authSource === "ldap"
            ? "The directory holds the credential — no password is set here."
            : undefined
        }
        error={fieldErrors.set_auth_source}
      />

      {authSource === "local" && (
        <div className="grid gap-3 rounded-md border border-border p-3">
          {!isEdit && (
            <SegmentedTabs
              items={[
                { value: "invite", label: "Email an invite" },
                { value: "manual", label: "Set a password" },
              ]}
              value={pwMode}
              onValueChange={(v) => setPwMode(v as "invite" | "manual")}
            />
          )}

          {!isEdit && pwMode === "invite" ? (
            <p className="text-xs text-muted-foreground">
              The user gets an email with a link to choose their own password —
              you never set or see it. Requires an email address above.
            </p>
          ) : (
            <FormText
              label={isEdit ? "Set new password" : "Password"}
              type="password"
              placeholder={
                isEdit ? "Leave blank to keep current" : "Choose a password"
              }
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              error={fieldErrors.password}
            />
          )}

          {isEdit && (
            <FormCheckbox
              label="Email a password-reset link"
              checked={pwMode === "invite"}
              onChange={(v) => setPwMode(v ? "invite" : "manual")}
              hint="Sends the user a link to set a new password themselves"
            />
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-border p-3">
        <FormCheckbox
          label="Active"
          checked={isActive}
          onChange={setIsActive}
          hint="Inactive users can't sign in"
        />
        <FormCheckbox
          label="Superuser"
          checked={isSuperuser}
          onChange={setIsSuperuser}
          hint="Bypasses all permission checks"
        />
        <FormCheckbox
          label="Require MFA"
          checked={requireMfa}
          onChange={setRequireMfa}
          hint="Prompt for a code at login"
        />
      </div>

      {!isEdit && (
        <div className="grid gap-3 rounded-md border border-border p-3">
          <FormCheckbox
            label="Site-scoped access (local IT)"
            checked={siteScoped}
            onChange={setSiteScoped}
            hint="Set up this user as a site editor/viewer in one step, instead of hand-building permissions."
          />
          {siteScoped && (
            <div className="grid gap-3 pl-1">
              <SegmentedTabs
                items={[
                  { value: "editor", label: "Editor (add/edit/delete)" },
                  { value: "viewer", label: "Viewer (read only)" },
                ]}
                value={siteRole}
                onValueChange={(v) => setSiteRole(v as "editor" | "viewer")}
              />
              <Field
                label="Sites"
                hint="They can only add/edit/delete objects in these sites"
              >
                <CheckList
                  options={siteOptions}
                  value={siteRoleSites}
                  onChange={setSiteRoleSites}
                  empty="No sites yet."
                />
              </Field>
              {siteRole === "editor" && (
                <FormCheckbox
                  label="Can only see their own sites"
                  checked={siteSilo}
                  onChange={setSiteSilo}
                  hint="Off (default) = read everything, edit only their sites — the usual local-IT model. On = a strict silo."
                />
              )}
            </div>
          )}
        </div>
      )}

      <Field label="Groups" hint="Permissions are granted through groups">
        <CheckList
          options={groupOptions}
          value={groupIds}
          onChange={setGroupIds}
          empty="No groups yet."
        />
      </Field>

      <Field label="Tenants" hint="Outer scope — leave empty for all tenants">
        <CheckList
          options={tenantOptions}
          value={tenantIds}
          onChange={setTenantIds}
          empty="No tenants yet."
        />
      </Field>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create user"}
      />
    </form>
  )
}
