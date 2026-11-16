import { createContext, useContext, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"

import { api } from "@/lib/api"
import type { DiscoveryPolicyScope, InventoryProfile } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { ProfileDialog } from "./profile-dialog"
import { useDiscoveryTab } from "./discovery-tab"

// A monitoring policy's Discovery line (#451): which discovery profiles
// name the same object in their own scope, and "New discovery profile from
// this scope". Read-only - saving a policy never starts or schedules a
// scan. Shown inside the policy's menu, so it is fetched only when the menu
// opens; the one profile dialog lives in the provider, not in every row.

type Open = (scope: DiscoveryPolicyScope) => void
const Ctx = createContext<Open | null>(null)

export function PolicyDiscoveryProvider({ children }: { children: ReactNode }) {
  const [from, setFrom] = useState<DiscoveryPolicyScope | null>(null)
  return (
    <Ctx.Provider value={setFrom}>
      {children}
      <ProfileDialog
        open={!!from}
        onOpenChange={(o) => !o && setFrom(null)}
        profile={null}
        fromPolicy={from}
      />
    </Ctx.Provider>
  )
}

/** The Discovery section of a policy's menu. Nothing without a saved
 *  policy, a provider, or the Discovery tab. */
export function PolicyDiscoveryItems({ policyId }: { policyId?: string }) {
  const open = useContext(Ctx)
  const visible = useDiscoveryTab()
  const { canDo } = useMe()
  const on = !!policyId && !!open && visible
  const canAdd = canDo("inventoryprofile", "add")
  const profiles = useQuery({
    queryKey: ["discovery", "profiles", "policy", policyId],
    queryFn: () =>
      api<{ results: InventoryProfile[] }>(
        `/api/discovery/profiles/?policy=${policyId}&page_size=20`
      ),
    enabled: on,
  })
  const scope = useQuery({
    queryKey: ["discovery", "policy-scope", policyId],
    queryFn: () =>
      api<DiscoveryPolicyScope>(`/api/discovery/policy-scopes/${policyId}/`),
    enabled: on && canAdd,
    retry: false,
  })
  if (!on) return null
  const rows = profiles.data?.results ?? []
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Discovery</DropdownMenuLabel>
      {profiles.isLoading ? (
        <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
      ) : rows.length === 0 ? (
        <DropdownMenuItem disabled>No profile names this</DropdownMenuItem>
      ) : (
        rows.map((p) => (
          <DropdownMenuItem key={p.id} asChild>
            <Link to="/discovery/$id" params={{ id: p.id }}>
              {p.name}
            </Link>
          </DropdownMenuItem>
        ))
      )}
      {canAdd && scope.data?.copyable && (
        <DropdownMenuItem onSelect={() => open(scope.data)}>
          <Plus />
          New discovery profile from this scope
        </DropdownMenuItem>
      )}
    </>
  )
}
