import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"

import { api, type ColumnPrefSummary } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  PRESETS_KEY,
  assigneeSummary,
  deletePreset,
  listPresets,
  resetPersonalLayouts,
  savePreset,
  type LayoutPreset,
  type PresetWrite,
  type ResetCounts,
} from "@/lib/layout-presets"
import { usePeople, usePeopleGroups } from "@/lib/people"
import { tableLabel } from "@/lib/tables"
import { DataTable } from "@/components/data-table"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { SettingsCard } from "@/components/settings/settings-card"
import {
  CheckList,
  Field,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/ui/info-tip"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Settings → Table layouts: shared layout presets. A preset is a set of
 * table layouts captured from your own, given as the default to users,
 * groups or everyone in the tenant. */
export function LayoutPresetsCard() {
  const q = useQuery({ queryKey: PRESETS_KEY, queryFn: listPresets })
  const [editing, setEditing] = useState<LayoutPreset | "new" | null>(null)

  const columns = useMemo<ColumnDef<LayoutPreset, unknown>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <button
            type="button"
            className="link text-left font-medium"
            onClick={() => setEditing(row.original)}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "tables",
        header: "Tables",
        accessorFn: (p) => Object.keys(p.tables).length,
        cell: ({ getValue }) => (
          <Badge variant="secondary" className="num">
            {getValue() as number}
          </Badge>
        ),
      },
      {
        id: "assigned",
        header: "Assigned to",
        accessorFn: (p) => assigneeSummary(p),
        cell: ({ row }) =>
          row.original.everyone ? (
            <Badge variant="info">Everyone</Badge>
          ) : (
            <span className="text-muted-foreground">
              {assigneeSummary(row.original)}
            </span>
          ),
      },
      { id: "weight", accessorKey: "weight", header: "Weight" },
      {
        id: "updated",
        header: "Updated",
        accessorFn: (p) => p.updated_at ?? "",
        cell: ({ row }) =>
          row.original.updated_at ? (
            <TimeCell iso={row.original.updated_at} />
          ) : (
            "-"
          ),
      },
    ],
    []
  )

  return (
    <SettingsCard
      title="Layout presets"
      description="Share your table layouts as the default for people, groups or everyone. Their own saved layouts still win."
    >
      <div className="flex justify-end">
        <Button size="sm" className="h-7" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-3.5 w-3.5" /> New preset from my layouts
        </Button>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : !q.data?.length ? (
        <EmptyState title="No presets yet." />
      ) : (
        <DataTable
          data={q.data}
          columns={columns}
          tableId="layout-presets"
          autoColumns={false}
          embedded
          enableExport={false}
          flexColumn="name"
          pinnable={false}
          unpaged
        />
      )}
      {editing && (
        <PresetDialog
          preset={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsCard>
  )
}

export function PresetDialog({
  preset,
  onClose,
}: {
  preset: LayoutPreset | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [name, setName] = useState(preset?.name ?? "")
  const [description, setDescription] = useState(preset?.description ?? "")
  const [weight, setWeight] = useState(String(preset?.weight ?? 100))
  const [everyone, setEveryone] = useState(preset?.everyone ?? false)
  const [groupIds, setGroupIds] = useState<number[]>(
    preset?.groups.map((g) => g.id) ?? []
  )
  const [userIds, setUserIds] = useState<number[]>(
    preset?.users.map((u) => u.id) ?? []
  )
  const [removed, setRemoved] = useState<string[]>([])
  // Which of your saved layouts to copy in: every one on a new preset, none
  // on an edit until you choose to re-capture.
  const [captureAll, setCaptureAll] = useState(!preset)
  const [capture, setCapture] = useState<string[]>([])
  const [confirmReset, setConfirmReset] = useState<ResetCounts | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const people = usePeople()
  const groups = usePeopleGroups()
  const mine = useQuery({
    queryKey: ["col-prefs-bulk"],
    queryFn: () =>
      api<Record<string, ColumnPrefSummary>>("/api/prefs/columns/"),
    staleTime: 60_000,
  })
  const myTables = useMemo(
    () =>
      Object.entries(mine.data ?? {})
        .filter(([id, s]) => s.has_user_row && id !== "dashboard")
        .map(([id]) => id)
        .sort((a, b) => tableLabel(a).localeCompare(tableLabel(b))),
    [mine.data]
  )

  const done = (msg: string) => {
    toast.success(msg)
    qc.invalidateQueries({ queryKey: PRESETS_KEY })
    qc.invalidateQueries({ queryKey: ["col-pref"] })
  }
  const save = useMutation({
    mutationFn: () => {
      const body: PresetWrite = {
        name: name.trim(),
        description,
        everyone,
        weight: Number(weight),
        group_ids: groupIds,
        user_ids: userIds,
      }
      if (captureAll) body.capture = "all"
      else if (capture.length) body.capture = capture
      else if (!preset) body.capture = []
      if (removed.length) body.remove_tables = removed
      return savePreset(preset?.id ?? null, body)
    },
    onSuccess: (p) => {
      done(preset ? `Updated ${p.name}` : `Created ${p.name}`)
      onClose()
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })
  const dryRun = useMutation({
    mutationFn: () => resetPersonalLayouts(preset!.id, true),
    onSuccess: setConfirmReset,
    onError: (e) => apiErrorToast(e),
  })
  const reset = useMutation({
    mutationFn: () => resetPersonalLayouts(preset!.id, false),
    onSuccess: (r) => {
      done(
        `Reset ${r.layouts} personal ${r.layouts === 1 ? "layout" : "layouts"}`
      )
      setConfirmReset(null)
    },
    onError: (e) => apiErrorToast(e),
  })
  const remove = useMutation({
    mutationFn: () => deletePreset(preset!.id),
    onSuccess: () => {
      done(`Deleted ${preset!.name}`)
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })

  const tables = Object.entries(preset?.tables ?? {}).filter(
    ([id]) => !removed.includes(id)
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="2xl" className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {preset ? preset.name : "New layout preset"}
          </DialogTitle>
        </DialogHeader>
        <form
          className="@container grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <div className="grid gap-3 @md:grid-cols-[1fr_8rem]">
            <FormText
              label="Name"
              required
              autoFocus={!preset}
              value={name}
              onChange={setName}
              error={fieldErrors.name}
            />
            <FormText
              label="Weight"
              type="number"
              min={0}
              max={32767}
              value={weight}
              onChange={setWeight}
              error={fieldErrors.weight}
              info="When two presets reach someone at the same level, the lower weight wins; then the name."
            />
          </div>
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />

          <Field
            label="Assigned to"
            group
            info="Order: your own layout, then presets for you, then for your groups, then for everyone, then the table's default."
          >
            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm whitespace-nowrap">
                <Switch checked={everyone} onCheckedChange={setEveryone} />
                Everyone
              </label>
              <div className="grid gap-3 @md:grid-cols-2">
                <div className="grid content-start gap-1">
                  <span className="text-[11px] font-medium whitespace-nowrap text-muted-foreground">
                    Groups
                  </span>
                  {groups.isLoading ? (
                    <Loading />
                  ) : (
                    <CheckList
                      options={(groups.data?.results ?? []).map((g) => ({
                        value: g.id,
                        label: g.name,
                      }))}
                      value={groupIds}
                      onChange={setGroupIds}
                      empty="No groups."
                    />
                  )}
                </div>
                <div className="grid content-start gap-1">
                  <span className="text-[11px] font-medium whitespace-nowrap text-muted-foreground">
                    Users
                  </span>
                  {people.isLoading ? (
                    <Loading />
                  ) : (
                    <CheckList
                      options={(people.data?.results ?? []).map((p) => ({
                        value: p.id,
                        label: p.display_name || p.username,
                      }))}
                      value={userIds}
                      onChange={setUserIds}
                      empty="No users."
                    />
                  )}
                </div>
              </div>
              {fieldErrors.user_ids && (
                <p className="text-xs text-destructive">
                  {fieldErrors.user_ids}
                </p>
              )}
              {fieldErrors.group_ids && (
                <p className="text-xs text-destructive">
                  {fieldErrors.group_ids}
                </p>
              )}
            </div>
          </Field>

          {preset && (
            <Field label="Tables" group>
              {tables.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tables.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {tables.map(([id, c]) => (
                    <li
                      key={id}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {tableLabel(id)}
                      </span>
                      <Badge variant="secondary" className="num">
                        {c.shown} shown
                      </Badge>
                      {c.hidden > 0 && (
                        <Badge variant="secondary" className="num">
                          {c.hidden} hidden
                        </Badge>
                      )}
                      {c.pinned > 0 && (
                        <Badge variant="secondary" className="num">
                          {c.pinned} pinned
                        </Badge>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Remove ${tableLabel(id)}`}
                            onClick={() => setRemoved((r) => [...r, id])}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent variant="default">
                          Remove
                        </TooltipContent>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          )}

          <Field
            label={preset ? "Re-capture from my layouts" : "Use my layouts"}
            group
            info="Copies your own saved layout of each table into the preset - columns, order, hidden and pinned."
          >
            <div className="grid gap-1.5">
              <label className="flex items-center gap-2 text-sm whitespace-nowrap">
                <Checkbox
                  checked={captureAll}
                  onCheckedChange={(v) => setCaptureAll(v === true)}
                />
                All my tables
                <span className="num text-xs text-muted-foreground">
                  {myTables.length}
                </span>
              </label>
              {!captureAll &&
                (mine.isLoading ? (
                  <Loading />
                ) : (
                  <CheckList
                    options={myTables.map((id) => ({
                      value: id,
                      label: tableLabel(id),
                    }))}
                    value={capture}
                    onChange={setCapture}
                    empty="You have no saved layouts."
                  />
                ))}
              {fieldErrors.capture && (
                <p className="text-xs text-destructive">
                  {fieldErrors.capture}
                </p>
              )}
            </div>
          </Field>

          <FormFooter
            onCancel={onClose}
            submitting={save.isPending}
            submitLabel={preset ? "Save" : "Create"}
            secondary={
              preset && (
                <div className="mr-auto flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={dryRun.isPending}
                    onClick={() => dryRun.mutate()}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    {dryRun.isPending ? "Counting…" : "Reset personal layouts"}
                  </Button>
                  <InfoTip>
                    Drops the assignees&apos; own layouts for this preset&apos;s
                    tables, so the preset applies to them too.
                  </InfoTip>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </Button>
                </div>
              )
            }
          />
        </form>
        {confirmReset && (
          <ConfirmDialog
            open
            onOpenChange={(o) => !o && setConfirmReset(null)}
            title="Reset personal layouts?"
            description={
              confirmReset.layouts === 0
                ? "No one this preset reaches has their own layout for its tables."
                : `${confirmReset.layouts} saved ${confirmReset.layouts === 1 ? "layout" : "layouts"} of ${confirmReset.users} ${confirmReset.users === 1 ? "user" : "users"} across ${confirmReset.tables} ${confirmReset.tables === 1 ? "table" : "tables"} go back to this preset.`
            }
            confirmLabel="Reset"
            pendingLabel="Resetting…"
            confirmDisabled={confirmReset.layouts === 0}
            pending={reset.isPending}
            onConfirm={() => reset.mutate()}
          />
        )}
        {confirmDelete && preset && (
          <ConfirmDialog
            open
            onOpenChange={setConfirmDelete}
            title={`Delete ${preset.name}?`}
            description="People it reaches fall back to the next preset or the table's default. Their own layouts stay."
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
