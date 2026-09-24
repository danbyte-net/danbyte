import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BadgeCheck } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  SlaAgreement,
  SlaCheckGroup,
  SlaObjectType,
  SlaStatusResponse,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { FormCombobox, FormSelect, FormText } from "@/components/forms"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Section } from "@/components/ui/section"
import {
  SLA_STATE_LABEL,
  SlaFigureBadge,
  fmtBudget,
  fmtSla,
} from "./sla-figure"

const KIND: Record<SlaObjectType, "device" | "vm" | "ip" | "prefix"> = {
  "api.device": "device",
  "api.virtualmachine": "vm",
  "api.ipaddress": "ip",
  "api.prefix": "prefix",
}

/** Pick an agreement and one of its groups, and add the objects to it. */
export function AddToSlaDialog({
  objectType,
  ids,
  open,
  onOpenChange,
  onAdded,
}: {
  objectType: SlaObjectType
  ids: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded?: () => void
}) {
  const qc = useQueryClient()
  const [agreement, setAgreement] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(null)
  const [redundancy, setRedundancy] = useState("")
  const agreements = useQuery({
    queryKey: ["sla-agreements", "picker"],
    queryFn: () =>
      api<Paginated<SlaAgreement>>(
        "/api/monitoring/sla-agreements/?page_size=200&status=active,draft"
      ),
    enabled: open,
  })
  const groups = useQuery({
    queryKey: ["sla-groups", agreement],
    queryFn: () =>
      api<Paginated<SlaCheckGroup>>(
        `/api/monitoring/sla-check-groups/?agreement=${agreement}&page_size=200`
      ),
    enabled: open && !!agreement,
  })
  const groupRows = groups.data?.results ?? []
  const pickedGroup: string | null = group ?? groupRows.at(0)?.id ?? null
  const add = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: number }>(
        "/api/monitoring/sla-members/bulk-add/",
        {
          method: "POST",
          body: JSON.stringify({
            agreement,
            group: pickedGroup,
            redundancy_group: redundancy.trim(),
            objects: ids.map((id) => ({
              object_type: objectType,
              object_id: id,
            })),
          }),
        }
      ),
    onSuccess: (r) => {
      toast.success(
        r.created === 0
          ? "Already in that group"
          : r.created === 1
            ? "Added to the agreement"
            : `Added ${r.created}`
      )
      qc.invalidateQueries({ queryKey: ["sla-status"] })
      qc.invalidateQueries({ queryKey: ["sla-agreements"] })
      onAdded?.()
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {ids.length === 1 ? "Add to SLA" : `Add ${ids.length} to SLA`}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate()
          }}
        >
          <FormCombobox
            label="Agreement"
            required
            value={agreement}
            onChange={(v) => {
              setAgreement(v)
              setGroup(null)
            }}
            options={(agreements.data?.results ?? []).map((a) => ({
              value: a.id,
              label: a.name,
            }))}
            placeholder="Pick an agreement"
            searchPlaceholder="Search agreements…"
            emptyText="No agreements yet."
          />
          {agreement && (
            <FormSelect
              label="Group"
              value={pickedGroup}
              onChange={setGroup}
              options={groupRows.map((g) => ({ value: g.id, label: g.name }))}
            />
          )}
          {agreement && groups.isSuccess && groupRows.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              This agreement has no check groups yet.{" "}
              <Link
                to="/monitoring/sla/$id"
                params={{ id: agreement }}
                search={{ tab: "groups" }}
                className="link"
              >
                Add one
              </Link>
            </p>
          )}
          <FormText
            label="Redundancy group"
            value={redundancy}
            onChange={setRedundancy}
            placeholder="leaf-pair-1"
            info="Members with the same label count as down only while all of them are down."
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!pickedGroup || add.isPending}>
              {add.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** "Add to SLA" for a list's selection bar. */
export function AddToSlaButton({
  objectType,
  ids,
  onAdded,
}: {
  objectType: SlaObjectType
  ids: string[]
  onAdded?: () => void
}) {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  if (!canDo("slaagreement", "add")) return null
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={() => setOpen(true)}
      >
        <BadgeCheck className="mr-1 h-3 w-3" /> Add to SLA
      </Button>
      <AddToSlaDialog
        objectType={objectType}
        ids={ids}
        open={open}
        onOpenChange={setOpen}
        onAdded={onAdded}
      />
    </>
  )
}

/**
 * The agreements an object is in, on its Monitoring tab: its figure in each
 * one's current period against that target, and "Add to SLA".
 */
export function ObjectSlaPanel({
  objectType,
  objectId,
}: {
  objectType: SlaObjectType
  objectId: string
}) {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ["sla-status", KIND[objectType], [objectId], "object"],
    queryFn: () =>
      api<SlaStatusResponse>("/api/monitoring/sla-status/", {
        method: "POST",
        body: JSON.stringify({ kind: KIND[objectType], ids: [objectId] }),
      }),
    enabled: canDo("slaagreement", "view"),
  })
  if (!canDo("slaagreement", "view")) return null
  const rows = q.data?.results[objectId]?.sla ?? []
  return (
    <Section
      title="SLAs"
      count={rows.length}
      actions={
        canDo("slaagreement", "add") && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <BadgeCheck className="h-3.5 w-3.5" /> Add to SLA
          </Button>
        )
      }
    >
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {q.isLoading ? "Loading..." : "In no agreement."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((s) => (
            <li
              key={s.agreement.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]"
            >
              <Link
                to="/monitoring/sla/$id"
                params={{ id: s.agreement.id }}
                className="link font-medium"
              >
                {s.agreement.name}
              </Link>
              <SlaFigureBadge figures={s} />
              <span className="text-muted-foreground">
                of {fmtSla(s.target)} · {s.period_key} ·{" "}
                {SLA_STATE_LABEL[s.state]} · budget left{" "}
                {fmtBudget(s.budget_left_s)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <AddToSlaDialog
        objectType={objectType}
        ids={[objectId]}
        open={open}
        onOpenChange={setOpen}
      />
    </Section>
  )
}
