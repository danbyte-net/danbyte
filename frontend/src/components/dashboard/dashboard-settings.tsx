import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useSaveObject } from "@/lib/save-object"
import type {
  DashboardScopeKey,
  NamedDashboard,
  Paginated,
  SlaAgreement,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Option = {
  id: string
  name?: string
  model?: string
  color?: string | null
}

function useOptions(key: string, url: string, enabled: boolean) {
  return (
    useQuery({
      queryKey: [key, "dash-scope"],
      queryFn: () => api<Paginated<Option>>(url),
      enabled,
      staleTime: 5 * 60_000,
    }).data?.results ?? []
  )
}

const SCOPE_LISTS: {
  key: Exclude<DashboardScopeKey, "tag" | "sla">
  label: string
  url: string
}[] = [
  { key: "site", label: "Sites", url: "/api/sites/?picker=1" },
  { key: "region", label: "Regions", url: "/api/regions/?picker=1" },
  { key: "role", label: "Device roles", url: "/api/device-roles/?picker=1" },
  {
    key: "device_type",
    label: "Device types",
    url: "/api/device-types/?picker=1&page_size=500",
  },
]

/** Name, sharing, scope, frame and refresh of a named dashboard. The same
 * form creates one (no `dashboard`) and edits its owner's own. */
export function DashboardSettingsDialog({
  dashboard: d,
  open,
  onOpenChange,
  onSaved,
}: {
  dashboard?: NamedDashboard
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (d: NamedDashboard) => void
}) {
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(d?.name ?? "")
  const [description, setDescription] = useState(d?.description ?? "")
  const [visibility, setVisibility] = useState(d?.visibility ?? "private")
  const [groups, setGroups] = useState<number[]>(d?.groups ?? [])
  const [scope, setScope] = useState(d?.scope ?? {})
  const [tags, setTags] = useState((d?.scope.tag ?? []).join(", "))
  const [frame, setFrame] = useState(d?.frame ?? "7d")
  const [refresh, setRefresh] = useState(String(d?.refresh_seconds ?? 0))

  const lists = {
    site: useOptions("sites", SCOPE_LISTS[0].url, open),
    region: useOptions("regions", SCOPE_LISTS[1].url, open),
    role: useOptions("device-roles", SCOPE_LISTS[2].url, open),
    device_type: useOptions("device-types", SCOPE_LISTS[3].url, open),
  }
  const agreements =
    useQuery({
      queryKey: ["sla-agreements", "dash-scope"],
      queryFn: () =>
        api<Paginated<SlaAgreement>>(
          "/api/monitoring/sla-agreements/?page_size=200"
        ),
      enabled: open,
    }).data?.results ?? []
  const shareGroups =
    useQuery({
      queryKey: ["dashboard-share-groups"],
      queryFn: () =>
        api<{ id: number; name: string }[]>("/api/dashboards/share-groups/"),
      enabled: open && visibility === "groups",
    }).data ?? []

  const save = useMutation({
    mutationFn: () => {
      reset()
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      return saveObject<NamedDashboard>({
        objectType: "core.dashboard",
        endpoint: "/api/dashboards/",
        id: d?.id,
        payload: {
          name: name.trim(),
          description,
          visibility,
          groups: visibility === "groups" ? groups : [],
          scope: { ...scope, tag: tagList },
          frame,
          refresh_seconds: Number(refresh),
        },
      })
    },
    onSuccess: (saved) => {
      toast.success(d ? "Dashboard saved" : `Created ${saved.name}`)
      qc.invalidateQueries({ queryKey: ["dashboards"] })
      qc.invalidateQueries({ queryKey: ["named-dashboard", saved.id] })
      onSaved(saved)
      onOpenChange(false)
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })

  const setList = (key: DashboardScopeKey, ids: string[]) =>
    setScope((s) => ({ ...s, [key]: ids }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {d ? "Dashboard settings" : "New dashboard"}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid max-h-[70vh] gap-4 overflow-auto pr-1"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormText
              label="Name"
              value={name}
              onChange={setName}
              required
              placeholder="Aarhus DC"
              error={fieldErrors.name}
            />
            <FormText
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
            <FormSelect
              label="Who sees it"
              value={visibility}
              onChange={(v) => setVisibility(v as typeof visibility)}
              options={[
                { value: "private", label: "Only me" },
                { value: "tenant", label: "Everyone in the tenant" },
                { value: "groups", label: "Chosen groups" },
              ]}
              info="Everyone sees only the data their own permissions allow."
            />
            <div className="grid grid-cols-2 gap-3">
              <FormSelect
                label="Time frame"
                value={frame}
                onChange={(v) => setFrame(v as typeof frame)}
                options={[
                  { value: "24h", label: "24 hours" },
                  { value: "7d", label: "7 days" },
                  { value: "30d", label: "30 days" },
                  { value: "90d", label: "90 days" },
                ]}
              />
              <FormSelect
                label="Refresh"
                value={refresh}
                onChange={(v) => v && setRefresh(v)}
                options={[
                  { value: "0", label: "When opened" },
                  { value: "30", label: "30 seconds" },
                  { value: "60", label: "1 minute" },
                  { value: "300", label: "5 minutes" },
                  { value: "900", label: "15 minutes" },
                ]}
              />
            </div>
          </div>
          {visibility === "groups" && (
            <Field label="Groups" error={fieldErrors.groups}>
              <CheckList
                options={shareGroups.map((g) => ({
                  value: g.id,
                  label: g.name,
                }))}
                value={groups}
                onChange={setGroups}
                className="max-h-32"
                empty="You are in no group."
              />
            </Field>
          )}
          <Field
            label="Scope"
            info="Widgets that support it show only what matches. Empty: everything."
            error={fieldErrors.scope}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {SCOPE_LISTS.map((l) => (
                <div key={l.key} className="grid gap-1">
                  <span className="text-xs text-muted-foreground">
                    {l.label}
                  </span>
                  <CheckList
                    options={lists[l.key].map((o) => ({
                      value: o.id,
                      label: o.name ?? o.model ?? "",
                      color: o.color,
                    }))}
                    value={scope[l.key] ?? []}
                    onChange={(ids) => setList(l.key, ids)}
                    className="max-h-28"
                  />
                </div>
              ))}
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">SLAs</span>
                <CheckList
                  options={agreements.map((a) => ({
                    value: a.id,
                    label: a.name,
                  }))}
                  value={scope.sla ?? []}
                  onChange={(ids) => setList("sla", ids)}
                  className="max-h-28"
                  empty="No agreements."
                />
              </div>
              <FormText
                label="Tags"
                value={tags}
                onChange={setTags}
                placeholder="core, production"
                info="Tag slugs, comma-separated; everything tagged with all of them."
              />
            </div>
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving..." : d ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A board's scope and frame as the query string its data is fetched with. */
export function scopeQuery(d: Pick<NamedDashboard, "scope" | "frame">): string {
  const p = new URLSearchParams()
  for (const [k, vals] of Object.entries(d.scope)) {
    if (vals.length) p.set(k, vals.join(","))
  }
  p.set("frame", d.frame)
  return p.toString()
}
