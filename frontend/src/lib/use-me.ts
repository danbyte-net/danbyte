import { useQuery } from "@tanstack/react-query"

import { api, type Me, type ObjectPerms } from "@/lib/api"

/**
 * Resolve whether the user may `change`/`delete` a *specific* object, preferring
 * the API's constraint-aware per-object `permissions` flag when the serializer
 * provides it (Prefix, Device, IPAddress), and falling back to the type-level
 * `canDo` result otherwise. Use this for Edit/Delete affordances on those rows
 * so a user constrained out of one row hides its button even when they hold the
 * type-level grant.
 */
export function objCan(
  obj: { permissions?: ObjectPerms } | null | undefined,
  action: "change" | "delete",
  fallback: boolean
): boolean {
  return obj?.permissions?.[action] ?? fallback
}

const ANON: Me = { is_authenticated: false, perms: [], permissions: {} }

// Current user's identity + effective permissions. Cached for the session —
// permissions only change on an admin edit, which the user won't see mid-page
// anyway. Anonymous callers resolve to ANON (200 from the backend), never an
// error, so consumers can read `.perms` unconditionally.
export function useMe() {
  const q = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/api/me/"),
    staleTime: 5 * 60_000,
  })
  const me = q.data ?? ANON
  return {
    me,
    isLoading: q.isLoading,
    /** Legacy convenience: does the user hold a flat permission slug? */
    can: (perm: string) => me.perms.includes(perm),
    /** Fine-grained: may the user perform `action` on `objectType`?
     * Superusers and the new RBAC map both resolve here. */
    canDo: (objectType: string, action: "view" | "add" | "change" | "delete") =>
      !!me.is_superuser ||
      (me.permissions?.[objectType]?.includes(action) ?? false),
    /** Can manage users/groups/permissions + this tenant's settings. */
    canManage: !!me.can_manage_users || me.perms.includes("users.manage"),
    /** Can edit deployment-wide settings (global email/LDAP, updates) — a
     * tenant-narrowed admin grant does NOT qualify. */
    canManageDeployment: !!me.can_manage_deployment,
    /** The install's display name — shown in the sidebar header, browser title,
     * and login pages. Set under Settings → Deployment; blank falls back to the
     * product name. */
    brandName: me.deployment_name?.trim() || "Danbyte",
    /** Whether to surface per-tenant human-readable numbers (numid). Defaults
     * to true unless the deployment toggle is explicitly off. */
    humanIds: me.human_ids_enabled !== false,
    /** May the user invite viewers to this specific site (delegation)?
     * True for admins/global editors ("all") or when the site is in their
     * delegable set. Always false when the deployment toggle is off. */
    canDelegateSite: (siteId: string) => {
      if (!me.site_delegation_enabled) return false
      const d = me.can_delegate_sites
      return d === "all" || (Array.isArray(d) && d.includes(siteId))
    },
    /** Enhanced site separation on for this tenant? When true, forms filter
     * site pickers to editableSites (see useSiteOptions). */
    siteSeparation: me.site_separation === true,
    /** Sites this user may WRITE in — "all", or a list of site ids. */
    editableSites: me.editable_sites ?? "all",
  }
}
