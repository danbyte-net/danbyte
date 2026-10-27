import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  PrtgConnection,
  PrtgRetireAction,
  PrtgRetireRule,
  TagOption,
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
  useFieldErrors,
} from "@/components/forms"
import { ColorBadge } from "@/components/cells/color-badge"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { Section } from "@/components/ui/section"
import { RowActions } from "@/components/row-actions"

interface StatusRow {
  id: string
  name: string
  slug: string
  color?: string | null
}

export const RETIRE_ACTIONS: { value: PrtgRetireAction; label: string }[] = [
  { value: "pause", label: "Pause in PRTG" },
  { value: "delete", label: "Delete in PRTG" },
  { value: "nothing", label: "Leave in PRTG" },
]

const ACTION_VARIANT: Record<
  PrtgRetireAction,
  "warning" | "destructive" | "secondary"
> = {
  pause: "warning",
  delete: "destructive",
  nothing: "secondary",
}

function useStatuses() {
  return useQuery({
    queryKey: ["prtg-retire-statuses"],
    queryFn: () => apiAll<StatusRow>("/api/statuses/"),
    staleTime: 10 * 60_000,
  })
}

function useTags() {
  return useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => apiAll<TagOption>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
}

/**
 * "When objects retire": the connection's retirement rules, in order. The
 * first rule whose statuses and tags match a linked device or VM decides
 * what the planning pass proposes for its PRTG device - pause, delete, or
 * nothing.
 */
export function PrtgRetireRules({
  connection,
  canManage,
}: {
  connection: PrtgConnection
  canManage: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<PrtgRetireRule | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<PrtgRetireRule | null>(null)
  const rules = useQuery({
    queryKey: ["prtg-retire-rules", connection.id],
    queryFn: () =>
      apiAll<PrtgRetireRule>(
        `/api/prtg/retire-rules/?connection=${connection.id}`
      ),
  })
  const statuses = useStatuses()
  const tags = useTags()
  const statusBySlug = useMemo(
    () => new Map((statuses.data?.results ?? []).map((s) => [s.slug, s])),
    [statuses.data]
  )
  const tagBySlug = useMemo(
    () => new Map((tags.data?.results ?? []).map((t) => [t.slug, t])),
    [tags.data]
  )

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/prtg/retire-rules/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule deleted")
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: ["prtg-retire-rules"] })
    },
    onError: apiErrorToast,
  })

  const rows = rules.data?.results ?? []
  const columns = useMemo<ColumnDef<PrtgRetireRule>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Rule",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "match",
        header: "Matches",
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            {row.original.statuses.map((slug) => {
              const s = statusBySlug.get(slug)
              return (
                <ColorBadge
                  key={`s-${slug}`}
                  name={s?.name ?? slug}
                  color={s?.color ?? undefined}
                />
              )
            })}
            {row.original.tags.map((slug) => {
              const t = tagBySlug.get(slug)
              return (
                <ColorBadge
                  key={`t-${slug}`}
                  name={t?.name ?? slug}
                  color={t?.color || undefined}
                />
              )
            })}
          </span>
        ),
      },
      {
        id: "action",
        accessorKey: "action",
        header: "Action",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1">
            <Badge variant={ACTION_VARIANT[row.original.action]}>
              {row.original.action_display}
            </Badge>
            {row.original.action === "delete" && row.original.allow_auto && (
              <Badge variant="secondary">Automatic</Badge>
            )}
            {row.original.action === "delete" && row.original.delete_any && (
              <Badge variant="secondary">Any device</Badge>
            )}
          </span>
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
            } as ColumnDef<PrtgRetireRule>,
          ]
        : []),
    ],
    [canManage, statusBySlug, tagBySlug]
  )

  return (
    <Section
      title="When objects retire"
      count={rows.length}
      actions={
        canManage && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </Button>
        )
      }
    >
      {rules.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No rules">
          A retired device stays in PRTG as it is.
        </EmptyState>
      ) : (
        <DataTable
          tableId="prtg-retire-rules"
          data={rows}
          total={rules.data?.count}
          columns={columns}
          flexColumn="match"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit rule" : "Add rule"}</DialogTitle>
          </DialogHeader>
          {(adding || !!editing) && (
            <RetireRuleForm
              connection={connection}
              rule={editing}
              next={rows.length}
              statuses={statuses.data?.results ?? []}
              tags={tags.data?.results ?? []}
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
        title={`Delete rule ${deleting?.name ?? ""}?`}
        description="Devices it paused are resumed by the next plan."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Section>
  )
}

export function RetireRuleForm({
  connection,
  rule,
  next,
  statuses,
  tags,
  onDone,
}: {
  connection: PrtgConnection
  rule: PrtgRetireRule | null
  next: number
  statuses: StatusRow[]
  tags: TagOption[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [name, setName] = useState(rule?.name ?? "")
  const [picked, setPicked] = useState<string[]>(rule?.statuses ?? [])
  const [tagSlugs, setTagSlugs] = useState<string[]>(rule?.tags ?? [])
  const [action, setAction] = useState<PrtgRetireAction>(
    rule?.action ?? "pause"
  )
  const [auto, setAuto] = useState(rule?.allow_auto ?? false)
  const [any, setAny] = useState(rule?.delete_any ?? false)
  const [position, setPosition] = useState(String(rule?.position ?? next))

  // The rule stores slugs; the shared tag picker works in ids.
  const tagIds = tags.filter((t) => tagSlugs.includes(t.slug)).map((t) => t.id)
  const onTags = (ids: number[]) =>
    setTagSlugs([
      ...tags.filter((t) => ids.includes(t.id)).map((t) => t.slug),
      ...tagSlugs.filter((slug) => !tags.some((t) => t.slug === slug)),
    ])

  const save = useMutation({
    mutationFn: () =>
      api<PrtgRetireRule>(
        rule ? `/api/prtg/retire-rules/${rule.id}/` : "/api/prtg/retire-rules/",
        {
          method: rule ? "PATCH" : "POST",
          body: JSON.stringify({
            connection: connection.id,
            name: name.trim(),
            statuses: picked,
            tags: tagSlugs,
            action,
            allow_auto: action === "delete" && auto,
            delete_any: action === "delete" && any,
            position: Number(position) || 0,
          }),
        }
      ),
    onSuccess: () => {
      toast.success(rule ? "Rule saved" : "Rule added")
      void qc.invalidateQueries({ queryKey: ["prtg-retire-rules"] })
      onDone()
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
        save.mutate()
      }}
      className="grid gap-4"
    >
      <FormText
        label="Name"
        required
        autoFocus={!rule}
        value={name}
        onChange={setName}
        placeholder="Retired"
        error={fieldErrors.name}
      />
      <Field
        label="Statuses"
        hint="any of them"
        info="The device's or VM's status must be one of these. With tags too, both must match."
        error={fieldErrors.statuses}
      >
        <IdMultiSelect
          options={statuses.map((s) => ({
            id: s.slug,
            name: s.name,
            color: s.color ?? null,
          }))}
          value={picked}
          onChange={setPicked}
          placeholder="Add a status…"
          searchPlaceholder="Search statuses…"
          emptyText="No statuses."
        />
      </Field>
      <Field label="Tags" hint="any of them" error={fieldErrors.tags}>
        <TagMultiSelect
          options={tags}
          value={tagIds}
          onChange={onTags}
          placeholder="Add a tag…"
        />
      </Field>
      <FormSelect
        label="Action"
        value={action}
        onChange={(v) => setAction((v ?? "pause") as PrtgRetireAction)}
        options={RETIRE_ACTIONS}
        error={fieldErrors.action}
      />
      {action === "delete" && (
        <>
          <FormCheckbox
            label="Apply automatically"
            info="With Apply automatically on the connection, the beat deletes without a person. Off: each delete waits in the Review queue."
            checked={auto}
            onChange={setAuto}
          />
          <FormCheckbox
            label="Delete devices Danbyte did not create"
            info="Off: only PRTG devices Danbyte created are deleted; the rest are proposed as Needs attention."
            checked={any}
            onChange={setAny}
          />
        </>
      )}
      <FormText
        label="Order"
        type="number"
        hint="lower runs first"
        value={position}
        onChange={setPosition}
        error={fieldErrors.position}
      />
      <FormFooter
        onCancel={onDone}
        submitting={save.isPending}
        submitLabel={rule ? "Save rule" : "Add rule"}
      />
    </form>
  )
}
