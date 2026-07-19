import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { PrefixForm } from "@/components/prefix-form"
import { EditPageShell } from "@/components/edit-page-shell"
import { Spinner } from "@/components/ui/spinner"
import type { Prefix } from "@/lib/api"
import { useCloneSeed } from "@/lib/use-clone"

export const Route = createFileRoute("/prefixes/new")({
  // `clone` is spread in so it stays an OPTIONAL search key — the other four are
  // long-standing required-but-nullable keys that every existing
  // `<Link to="/prefixes/new">` already spells out, and making clone required
  // would force all of them to pass `clone: undefined`.
  validateSearch: (s: Record<string, unknown>) => ({
    cidr: typeof s.cidr === "string" ? s.cidr : undefined,
    vrf: typeof s.vrf === "string" ? s.vrf : undefined,
    site: typeof s.site === "string" ? s.site : undefined,
    location: typeof s.location === "string" ? s.location : undefined,
    ...(typeof s.clone === "string" ? { clone: s.clone } : {}),
  }),
  component: NewPrefixPage,
})

function NewPrefixPage() {
  const { cidr, vrf, site, location, clone } = Route.useSearch()
  const nav = useNavigate()
  const cloneQ = useCloneSeed<Partial<Prefix>>("prefixes", clone)
  const cloning = !!clone

  return (
    <EditPageShell
      crumbs={[
        { label: "Prefixes", to: "/prefixes" },
        { label: cloning ? "Clone" : "Add" },
      ]}
      title={cloning ? "Clone prefix" : "Add prefix"}
      subtitle={
        cloning
          ? "Pre-filled from an existing prefix — enter the new CIDR."
          : "Register a new IP prefix in the active tenant."
      }
    >
      {cloning && cloneQ.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading source prefix…
        </div>
      ) : (
        <PrefixForm
          initial={{
            cidr,
            vrfId: vrf ?? null,
            siteId: site ?? null,
            locationId: location ?? null,
          }}
          clone={cloning ? cloneQ.data?.initial : undefined}
          onSaved={(p) => nav({ to: "/prefixes/$id", params: { id: p.id } })}
          onCancel={() => nav({ to: "/prefixes" })}
        />
      )}
    </EditPageShell>
  )
}
