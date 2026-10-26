import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  PrtgConnection,
  PrtgSensorDefinition,
  PrtgSensorKind,
  PrtgSensorProfile,
  PrtgSensorSchema,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"
import { SchemaFields } from "./add-sensor"
import { SensorKindPicker, usePrtgSensorKinds } from "./sensor-kind-picker"

const INTERVAL_LABEL = (s: number) =>
  s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`

export { usePrtgSensorKinds }

/** Named lists of the sensors a device or VM should carry in PRTG. */
export function PrtgProfiles({
  connection,
  canManage,
}: {
  connection: PrtgConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<PrtgSensorProfile | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PrtgSensorProfile | null>(null)

  const profiles = useQuery({
    queryKey: ["prtg-profiles", connection.id],
    queryFn: () =>
      apiAll<PrtgSensorProfile>(
        `/api/prtg/profiles/?connection=${connection.id}`
      ),
  })
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ["prtg-profiles"] })
  const starter = useMutation({
    mutationFn: () =>
      api<PrtgSensorProfile>("/api/prtg/profiles/starter/", {
        method: "POST",
        body: JSON.stringify({ connection: connection.id }),
      }),
    onSuccess: (p) => {
      toast.success(`Made ${p.name}`)
      refresh()
    },
    onError: apiErrorToast,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/profiles/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Profile deleted")
      setDeleting(null)
      refresh()
    },
    onError: (e) => {
      setDeleting(null)
      apiErrorToast(e)
    },
  })
  const rows = profiles.data?.results ?? []

  const columns = useMemo<ColumnDef<PrtgSensorProfile>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "sensors",
        header: "Sensors",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.definitions.length ? (
            <span className="flex flex-wrap gap-1">
              {row.original.definitions.map((d, i) => (
                <Badge
                  key={d.id ?? i}
                  variant={d.required ? "secondary" : "outline"}
                >
                  {d.name || d.kind_label || d.kind}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "used",
        accessorKey: "policy_count",
        header: ({ column }) => <SortHeader column={column} label="Policies" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.policy_count}</span>
        ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              enableHiding: false,
              cell: ({ row }) => (
                <RowActions
                  onEdit={() => setEditing(row.original)}
                  onDelete={() => setDeleting(row.original)}
                />
              ),
            } as ColumnDef<PrtgSensorProfile>,
          ]
        : []),
    ],
    [canManage]
  )

  return (
    <Section
      title="Sensor profiles"
      count={rows.length}
      actions={
        canManage && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={starter.isPending}
              onClick={() => starter.mutate(undefined)}
            >
              {starter.isPending ? "Making…" : "Starter profile"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add profile
            </Button>
          </>
        )
      }
    >
      {profiles.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No profiles">
          A profile lists the sensors a device should carry in PRTG.
        </EmptyState>
      ) : (
        <DataTable
          tableId="prtg-profiles"
          data={rows}
          total={profiles.data?.count}
          columns={columns}
          flexColumn="sensors"
        />
      )}

      <Dialog
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      >
        <DialogContent size="3xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing.name}` : "Add profile"}
            </DialogTitle>
          </DialogHeader>
          {(adding || !!editing) && (
            <ProfileForm
              connection={connection}
              profile={editing}
              onDone={() => {
                setAdding(false)
                setEditing(null)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "this profile"}?`}
        description="Nothing in PRTG changes."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Section>
  )
}

type Row = PrtgSensorDefinition & { _key: string }

let nextKey = 0
const newKey = () => `n${++nextKey}`

function defaultsFor(kind: PrtgSensorKind | undefined) {
  const out: Record<string, unknown> = {}
  for (const p of kind?.params ?? []) out[p.name] = p.default
  return out
}

/** A Danbyte sensor kind's parameters as form fields: the profile editor's
 * definitions and the Add sensor dialog share them. */
export function KindParamFields({
  kind,
  params,
  onChange,
  skip,
}: {
  kind: PrtgSensorKind
  params: Record<string, unknown>
  onChange: (params: Record<string, unknown>) => void
  /** Parameters this surface sets another way (the scanned interfaces). */
  skip?: string[]
}) {
  const shown = kind.params.filter((p) => !skip?.includes(p.name))
  if (shown.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {shown.map((p) => {
        const value = params[p.name] ?? p.default
        const set = (v: unknown) => onChange({ ...params, [p.name]: v })
        if (p.type === "bool")
          return (
            <FormCheckbox
              key={p.name}
              label={p.label}
              checked={!!value}
              onChange={set}
            />
          )
        if (p.type === "choice")
          return (
            <FormSelect
              key={p.name}
              label={p.label}
              value={value == null ? null : String(value)}
              onChange={set}
              options={p.choices.map((c) => ({ value: c, label: c }))}
            />
          )
        return (
          <FormText
            key={p.name}
            label={p.label}
            required={p.required}
            type={p.type === "int" ? "number" : undefined}
            value={value == null ? "" : String(value)}
            onChange={(v) =>
              set(p.type === "int" ? (v === "" ? null : Number(v)) : v)
            }
          />
        )
      })}
    </div>
  )
}

export { defaultsFor as kindDefaults, INTERVAL_LABEL }

/** A PRTG-only kind's parameters: PRTG's create form for it, read through
 * the connection, as `section.field` values. */
function GenericParams({
  connectionId,
  kind,
  params,
  onChange,
}: {
  connectionId: string
  kind: string
  params: Record<string, unknown>
  onChange: (params: Record<string, unknown>) => void
}) {
  const schema = useQuery({
    queryKey: ["prtg-connection-schema", connectionId, kind],
    queryFn: () =>
      api<PrtgSensorSchema>(
        `/api/prtg/connections/${connectionId}/sensor-schema/?kind=${encodeURIComponent(kind)}`
      ),
    staleTime: 10 * 60_000,
    retry: false,
  })
  if (schema.isLoading) return <Loading />
  if (schema.isError) return <QueryError error={schema.error} />
  const fields = schema.data?.fields ?? []
  return (
    <>
      {fields.length > 0 && (
        <SchemaFields fields={fields} values={params} onChange={onChange} />
      )}
      {schema.data?.scan && (
        <p className="text-xs text-muted-foreground">
          Every row PRTG&apos;s scan finds becomes a sensor.
        </p>
      )}
    </>
  )
}

export function ProfileForm({
  connection,
  profile,
  onDone,
  onSaved,
}: {
  connection: PrtgConnection
  profile: PrtgSensorProfile | null
  onDone: () => void
  /** The saved profile, e.g. to pick it in the policy editor. */
  onSaved?: (profile: PrtgSensorProfile) => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const kinds = usePrtgSensorKinds()
  const byKind = useMemo(
    () => new Map((kinds.data?.kinds ?? []).map((k) => [k.value, k])),
    [kinds.data]
  )
  const [name, setName] = useState(profile?.name ?? "")
  const [description, setDescription] = useState(profile?.description ?? "")
  const [rows, setRows] = useState<Row[]>(
    (profile?.definitions ?? []).map((d) => ({ ...d, _key: d.id ?? newKey() }))
  )

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, ...patch } : r)))
  const move = (i: number, by: number) =>
    setRows((rs) => {
      const j = i + by
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const add = () =>
    setRows((rs) => [
      ...rs,
      {
        _key: newKey(),
        kind: "ping",
        name: "",
        params: {},
        interval_seconds: null,
        required: true,
        tags: [],
      },
    ])

  const save = useMutation({
    mutationFn: () =>
      api<PrtgSensorProfile>(
        profile ? `/api/prtg/profiles/${profile.id}/` : "/api/prtg/profiles/",
        {
          method: profile ? "PATCH" : "POST",
          body: JSON.stringify({
            connection: connection.id,
            name: name.trim(),
            description,
            definitions: rows.map((r) => ({
              ...(r.id ? { id: r.id } : {}),
              kind: r.kind,
              name: r.name,
              params: r.params,
              interval_seconds: r.interval_seconds,
              required: r.required,
              tags: r.tags,
            })),
          }),
        }
      ),
    onSuccess: (saved) => {
      toast.success(profile ? "Profile saved" : "Profile added")
      void qc.invalidateQueries({ queryKey: ["prtg-profiles"] })
      onSaved?.(saved)
      onDone()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const intervals = kinds.data?.intervals ?? []
  const defErrors = (fieldErrors as Record<string, unknown>).definitions

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="grid gap-4"
    >
      <FormText
        label="Name"
        required
        value={name}
        onChange={setName}
        error={fieldErrors.name}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
      />
      <div className="grid gap-3">
        {rows.map((r, i) => {
          const kind = byKind.get(r.kind)
          return (
            <div
              key={r._key}
              className="grid gap-3 rounded-lg border border-border p-3"
              data-testid="prtg-definition"
            >
              <div className="flex items-end gap-2">
                <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                  <Field label="Sensor">
                    <SensorKindPicker
                      connectionId={connection.id}
                      value={r.kind}
                      fallbackLabel={r.kind_label}
                      onChange={(o) =>
                        update(r._key, {
                          kind: o.id,
                          kind_label: o.name,
                          form: o.form,
                          params: o.spec ? defaultsFor(o.spec) : {},
                        })
                      }
                    />
                  </Field>
                  <FormText
                    label="Name"
                    hint={
                      (kind ? kind.default_name : r.kind_label) || undefined
                    }
                    value={r.name}
                    onChange={(v) => update(r._key, { name: v })}
                  />
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Move up"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Move down"
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove sensor"
                  onClick={() =>
                    setRows((rs) => rs.filter((x) => x._key !== r._key))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {kind ? (
                <KindParamFields
                  kind={kind}
                  params={r.params}
                  onChange={(params) => update(r._key, { params })}
                />
              ) : (
                kinds.data && (
                  <GenericParams
                    connectionId={connection.id}
                    kind={r.kind}
                    params={r.params}
                    onChange={(params) => update(r._key, { params })}
                  />
                )
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <FormSelect
                  label="Interval"
                  value={
                    r.interval_seconds == null
                      ? null
                      : String(r.interval_seconds)
                  }
                  onChange={(v) =>
                    update(r._key, { interval_seconds: v ? Number(v) : null })
                  }
                  options={intervals.map((s) => ({
                    value: String(s),
                    label: INTERVAL_LABEL(s),
                  }))}
                  noneLabel="Inherit"
                />
                <FormText
                  label="Tags"
                  hint="space-separated"
                  value={r.tags.join(" ")}
                  onChange={(v) =>
                    update(r._key, { tags: v.split(/\s+/).filter(Boolean) })
                  }
                />
                <FormCheckbox
                  label="Required"
                  info="A required sensor a linked device lacks is proposed. An optional one is only part of what a new device gets."
                  checked={r.required}
                  onChange={(v) => update(r._key, { required: v })}
                />
              </div>
            </div>
          )
        })}
        {Array.isArray(defErrors) && defErrors.some(Boolean) && (
          <p className="text-xs text-destructive">
            {JSON.stringify(defErrors.filter(Boolean))}
          </p>
        )}
        <div>
          <Button type="button" size="sm" variant="outline" onClick={add}>
            <Plus className="h-3.5 w-3.5" />
            Add sensor
          </Button>
        </div>
      </div>
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={profile ? "Save profile" : "Add profile"}
      />
    </form>
  )
}
