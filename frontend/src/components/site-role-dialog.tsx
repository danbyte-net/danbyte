import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ObjectPermission,
  type Paginated,
  type RBACGroup,
  type RBACUser,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  CheckList,
  Field,
  FormText,
  type CheckOption,
} from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

type SiteRole = "editor" | "viewer"

const ROLE_BLURB: Record<SiteRole, string> = {
  editor:
    "Edit everything in the chosen site(s) — devices, prefixes, IPs, racks… — and read everything elsewhere. The “local IT” recipe.",
  viewer: "Read-only access to the chosen site(s). Nothing outside them.",
}

/**
 * One-click "Site editor / Site viewer" template. Assembles the right
 * ObjectPermission combo server-side (`POST /api/rbac/site-role/`) so admins
 * don't hand-build the scoped-edit + unscoped-read pair every time.
 */
export function SiteRoleDialog({
  open,
  onOpenChange,
  lockedSiteId,
  lockedSiteName,
  viewerOnly,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-scope the role to one site and hide the site picker. */
  lockedSiteId?: string
  lockedSiteName?: string
  /** Lock to "viewer" and hide the role toggle — used for delegated invites
   * by a local site editor (who may never mint editors). */
  viewerOnly?: boolean
}) {
  const qc = useQueryClient()
  const [role, setRole] = useState<SiteRole>(viewerOnly ? "viewer" : "editor")
  const [name, setName] = useState("")
  const [siteIds, setSiteIds] = useState<string[]>(
    lockedSiteId ? [lockedSiteId] : []
  )
  const [userIds, setUserIds] = useState<number[]>([])
  const [groupIds, setGroupIds] = useState<number[]>([])

  const sitesQuery = useQuery({
    queryKey: ["sites", "picker"],
    queryFn: () => api<Paginated<{ id: string; name: string }>>("/api/sites/"),
    enabled: open && !lockedSiteId,
  })
  const usersQuery = useQuery({
    queryKey: ["users", ""],
    queryFn: () => api<Paginated<RBACUser>>("/api/users/"),
    enabled: open,
  })
  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
    enabled: open,
  })

  const siteOptions: CheckOption<string>[] = (
    sitesQuery.data?.results ?? []
  ).map((s) => ({ value: s.id, label: s.name }))
  const userOptions: CheckOption<number>[] = (
    usersQuery.data?.results ?? []
  ).map((u) => ({ value: u.id, label: u.username }))
  const groupOptions: CheckOption<number>[] = (
    groupsQuery.data?.results ?? []
  ).map((g) => ({ value: g.id, label: g.name }))

  const reset = () => {
    setRole(viewerOnly ? "viewer" : "editor")
    setName("")
    setSiteIds(lockedSiteId ? [lockedSiteId] : [])
    setUserIds([])
    setGroupIds([])
  }

  const mutation = useMutation({
    mutationFn: () =>
      api<{ created: ObjectPermission[] }>("/api/rbac/site-role/", {
        method: "POST",
        body: JSON.stringify({
          role,
          name: name.trim() || undefined,
          site_ids: siteIds,
          user_ids: userIds,
          group_ids: groupIds,
        }),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["object-permissions"] })
      qc.invalidateQueries({ queryKey: ["me"] })
      const n = res.created.length
      toast.success(
        `Created ${n} permission${n > 1 ? "s" : ""} for the site ${role}`
      )
      reset()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const canSubmit = siteIds.length > 0 && !mutation.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {viewerOnly ? "Invite a viewer" : "Site role"}
          </DialogTitle>
          <DialogDescription>
            {viewerOnly
              ? "Give a user or group read-only access to this site."
              : "Grant a user or group scoped access to one or more sites without hand-building permissions."}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) mutation.mutate()
          }}
          className="grid gap-4"
        >
          {!viewerOnly && (
            <Field label="Role">
              <div className="grid grid-cols-2 gap-2">
                {(["editor", "viewer"] as SiteRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={
                      "rounded-md border px-3 py-2 text-left text-sm capitalize transition-colors " +
                      (role === r
                        ? "border-primary bg-primary/5 font-medium text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted/50")
                    }
                  >
                    Site {r}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {ROLE_BLURB[role]}
              </p>
            </Field>
          )}

          <FormText
            label="Label (optional)"
            value={name}
            onChange={setName}
            placeholder="Defaults to the site name(s)"
          />

          {lockedSiteId ? (
            <Field label="Site" hint="This role is scoped to this site">
              <span className="inline-flex rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {lockedSiteName ?? lockedSiteId}
              </span>
            </Field>
          ) : (
            <Field
              label="Sites"
              hint="Which site(s) this role is scoped to (required)"
            >
              <CheckList
                options={siteOptions}
                value={siteIds}
                onChange={setSiteIds}
                empty={
                  sitesQuery.isLoading ? "Loading sites…" : "No sites yet."
                }
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Users" hint="Direct grants">
              <CheckList
                options={userOptions}
                value={userIds}
                onChange={setUserIds}
                empty="No users yet."
              />
            </Field>
            <Field label="Groups" hint="Members get this role">
              <CheckList
                options={groupOptions}
                value={groupIds}
                onChange={setGroupIds}
                empty="No groups yet."
              />
            </Field>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? "Creating…" : "Create site role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
