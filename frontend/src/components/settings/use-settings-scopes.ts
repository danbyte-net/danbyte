import { useMe } from "@/lib/use-me"

/** Which settings tiers this person holds.
 *
 * One place, because the sidebar, the hub and every scoped page ask the same
 * question - and the site rule is not obvious: a tenant admin manages every
 * site anyway, so `settings_sites: "all"` only means something for someone
 * who is not one. */
export function useSettingsScopes() {
  const { me, canManage, canManageDeployment } = useMe()
  const sites = me.settings_sites ?? []
  return {
    user: true,
    site: sites === "all" ? canManage : sites.length > 0,
    tenant: canManage,
    deployment: canManageDeployment,
  }
}
