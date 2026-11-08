import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus, RotateCw, X } from "lucide-react"

import type { DeviceProfileAssignment } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { OverviewTable } from "@/components/overview-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import {
  ASSIGN_ENDPOINT,
  ApplyProfileDialog,
  ProfileBadge,
  ProfileStateBadge,
  UnassignProfileDialog,
  profileHostParam,
  useReapplyProfile,
} from "@/components/device-profile-assign"
import type { ProfileHost } from "@/components/device-profile-assign"

// The Overview's "Profiles" card on device and VM pages: the object's
// profiles in order with their state, Re-apply and Unassign, and Apply
// profile.

export function DeviceProfilesCard({ host }: { host: ProfileHost }) {
  const { canDo } = useMe()
  const canView = canDo("deviceprofileassignment", "view")
  const canAdd = canDo("deviceprofileassignment", "add")
  const canDelete = canDo("deviceprofileassignment", "delete")
  const canReapply = canDo("deviceprofileassignment", "change")
  const [applying, setApplying] = useState(false)
  const [unassigning, setUnassigning] =
    useState<DeviceProfileAssignment | null>(null)
  const reapply = useReapplyProfile()
  const q = useQuery({
    queryKey: ["device-profile-assignments", host.kind, host.id],
    queryFn: () =>
      apiAll<DeviceProfileAssignment>(
        `${ASSIGN_ENDPOINT}?${profileHostParam(host)}`
      ),
    enabled: canView,
  })
  if (!canView) return null
  const rows = q.data?.results ?? []

  const apply = canAdd ? (
    <Button size="sm" variant="outline" onClick={() => setApplying(true)}>
      <Plus className="h-3.5 w-3.5" /> Apply profile
    </Button>
  ) : null

  const columns: SimpleColumn<DeviceProfileAssignment>[] = [
    {
      id: "profile",
      header: "Profile",
      cell: (a) => <ProfileBadge profile={a.profile} />,
    },
    {
      id: "state",
      header: "State",
      cell: (a) => <ProfileStateBadge state={a.state} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) => (
        <span className="inline-flex gap-1">
          {canReapply && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Re-apply"
              disabled={reapply.isPending}
              onClick={() => reapply.mutate(a)}
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span className="sr-only">Re-apply {a.profile.name}</span>
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Unassign"
              onClick={() => setUnassigning(a)}
            >
              <X className="h-3.5 w-3.5" />
              <span className="sr-only">Unassign {a.profile.name}</span>
            </Button>
          )}
        </span>
      ),
    },
  ]

  return (
    <>
      {rows.length > 0 ? (
        <OverviewTable
          title="Profiles"
          count={rows.length}
          columns={columns}
          data={rows}
          getRowKey={(a) => a.id}
          actions={apply}
        />
      ) : (
        <Section title="Profiles" actions={apply}>
          {q.isLoading ? (
            <Loading />
          ) : q.isError ? (
            <QueryError error={q.error} />
          ) : (
            <p className="text-sm text-muted-foreground">No profiles.</p>
          )}
        </Section>
      )}
      <ApplyProfileDialog
        host={host}
        assignedIds={rows.map((a) => a.profile.id)}
        open={applying}
        onOpenChange={setApplying}
      />
      <UnassignProfileDialog
        assignment={unassigning}
        onOpenChange={(o) => !o && setUnassigning(null)}
      />
    </>
  )
}
