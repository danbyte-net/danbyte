import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import type {
  AutomationTarget,
  DeployPipeline,
  DeployPipelineRun,
  DeployRun,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { Field, FormCheckbox, FormCombobox } from "@/components/forms"
import { Loading } from "@/components/loading"

export interface DeployChoice {
  kind: "pipeline" | "target"
  id: string
  dryRun: boolean
}

/** What a deploy endpoint answers: a target's run, or a pipeline's. */
export type DeployResult =
  ({ kind: "pipeline" } & DeployPipelineRun) | ({ kind?: "target" } & DeployRun)

const SINGLE = "__target__"

function covers(types: string[], slug: string): boolean {
  const t = types.length ? types : ["device"]
  return t.includes("*") || t.includes(slug)
}

/** The pipeline this object's role makes the default, if any. */
export function defaultPipeline(
  pipelines: DeployPipeline[],
  roleIds: (string | null | undefined)[]
): DeployPipeline | undefined {
  const roles = new Set(roleIds.filter(Boolean) as string[])
  if (!roles.size) return undefined
  return pipelines.find((p) => p.roles.some((r) => roles.has(r)))
}

/**
 * Deploy something: run a pipeline (the one its role makes the default is
 * preselected, its steps listed) or a single automation target as before,
 * optionally as a dry run. Used by the device's Deploy, the devices bulk
 * bar and a VM's Provision. `submit` posts the choice to the caller's
 * endpoint.
 */
export function DeployDialog({
  open,
  onOpenChange,
  title,
  description,
  objectType = "device",
  roleIds = [],
  verb = "Deploy",
  submit,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  objectType?: "device" | "virtualmachine"
  roleIds?: (string | null | undefined)[]
  verb?: string
  submit: (choice: DeployChoice) => Promise<DeployResult>
  onDone?: (result: DeployResult) => void
}) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const pipelines = useQuery({
    queryKey: ["deploy-pipelines", "enabled", objectType],
    queryFn: () =>
      apiAll<DeployPipeline>(
        `/api/deploy-pipelines/?enabled=true&object_type=${objectType}`
      ),
    staleTime: 60_000,
    enabled: open,
  })
  const targets = useQuery({
    queryKey: ["automation-targets", "enabled"],
    queryFn: () => apiAll<AutomationTarget>("/api/automation-targets/"),
    staleTime: 60_000,
    enabled: open,
  })
  const pipelineRows = useMemo(
    () =>
      (pipelines.data?.results ?? []).filter(
        (p) => p.enabled && covers(p.object_types, objectType)
      ),
    [pipelines.data, objectType]
  )
  const targetOptions = (targets.data?.results ?? [])
    .filter((t) => t.enabled && covers(t.object_types, objectType))
    .map((t) => ({ value: t.id, label: `${t.name} · ${t.kind_display}` }))
  const roleKey = roleIds.filter(Boolean).join(",")
  const preferred = useMemo(
    () => defaultPipeline(pipelineRows, roleKey ? roleKey.split(",") : []),
    [pipelineRows, roleKey]
  )

  const [via, setVia] = useState<string | null>(null)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState(false)

  // Each opening starts from the role's default pipeline.
  useEffect(() => {
    if (!open) {
      setVia(null)
      setTargetId(null)
      setDryRun(false)
    }
  }, [open])
  useEffect(() => {
    if (!open || via !== null || pipelines.isLoading || targets.isLoading)
      return
    setVia(preferred?.id ?? (pipelineRows.length ? null : SINGLE))
  }, [
    open,
    via,
    preferred,
    pipelineRows.length,
    pipelines.isLoading,
    targets.isLoading,
  ])

  const picked = pipelineRows.find((p) => p.id === via)
  const isPipe = via !== null && via !== SINGLE
  const choice: DeployChoice | null = isPipe
    ? { kind: "pipeline", id: via, dryRun }
    : via === SINGLE && targetId
      ? { kind: "target", id: targetId, dryRun }
      : null

  const m = useMutation({
    mutationFn: () => submit(choice!),
    onSuccess: (res) => {
      if (res.kind === "pipeline") {
        qc.invalidateQueries({ queryKey: ["deploy-pipeline-runs"] })
        toast.success(`${res.pipeline_name} started`, {
          action: {
            label: "Open run",
            onClick: () =>
              nav({ to: "/pipelines/runs/$runId", params: { runId: res.id } }),
          },
        })
      } else if (res.status === "failed")
        toast.error(`${verb} failed: ${res.detail || "see run"}`)
      else toast.success(`${verb} ${res.status}`)
      qc.invalidateQueries({ queryKey: ["deploy-runs"] })
      onOpenChange(false)
      onDone?.(res)
    },
    onError: (err) => apiErrorToast(err),
  })

  const loading = pipelines.isLoading || targets.isLoading
  const nothing =
    !loading && pipelineRows.length === 0 && targetOptions.length === 0
  const cta = `${dryRun ? "Dry run" : verb} ${isPipe ? "pipeline" : "target"}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {loading ? (
          <Loading />
        ) : nothing ? (
          <p className="text-sm text-muted-foreground">
            No enabled pipeline or automation target takes{" "}
            {objectType === "virtualmachine" ? "virtual machines" : "devices"}.{" "}
            <Link to="/pipelines" className="link">
              Pipelines
            </Link>{" "}
            ·{" "}
            <Link to="/automation-targets" className="link">
              Automation targets
            </Link>
          </p>
        ) : (
          <div className="grid gap-4">
            <Field label="Run with" group>
              <RadioGroup
                value={via ?? ""}
                onValueChange={(v) => setVia(v)}
                className="grid gap-2"
                aria-label="Run with"
              >
                {pipelineRows.map((p) => (
                  <ChoiceCard
                    key={p.id}
                    value={p.id}
                    selected={via === p.id}
                    title={p.name}
                    badges={
                      <>
                        <Badge variant="outline" className="num text-[10px]">
                          {p.steps_count} step{p.steps_count === 1 ? "" : "s"}
                        </Badge>
                        {p.id === preferred?.id && (
                          <Badge variant="info" className="text-[10px]">
                            Role default
                          </Badge>
                        )}
                      </>
                    }
                    note={p.description || undefined}
                  />
                ))}
                {targetOptions.length > 0 && (
                  <ChoiceCard
                    value={SINGLE}
                    selected={via === SINGLE}
                    title="Single target"
                    badges={
                      <Badge variant="outline" className="text-[10px]">
                        Target
                      </Badge>
                    }
                  />
                )}
              </RadioGroup>
            </Field>

            {picked && (
              <Field label="Steps" group>
                <ol className="divide-y divide-border rounded-md border border-border text-xs">
                  {picked.steps.map((s, i) => (
                    <li
                      key={s.id ?? s.order}
                      className="flex items-center gap-2 px-3 py-1.5"
                    >
                      <Badge
                        variant="secondary"
                        className="num min-w-5 justify-center px-1 text-[10px]"
                      >
                        {i + 1}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate">
                        {s.target_name}
                      </span>
                      {s.wait_for_result && (
                        <Badge variant="secondary" className="text-[10px]">
                          Waits for result
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-[10px]">
                        {s.target_kind_display}
                      </Badge>
                    </li>
                  ))}
                </ol>
              </Field>
            )}

            {via === SINGLE && (
              <FormCombobox
                label="Target"
                value={targetId}
                onChange={setTargetId}
                options={targetOptions}
                placeholder="Pick a target"
                searchPlaceholder="Search targets…"
                emptyText="No targets."
              />
            )}

            <FormCheckbox
              label="Dry run"
              checked={dryRun}
              onChange={setDryRun}
              info='Every step gets "dry_run": true and only reports what it would do.'
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!choice || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Starting…" : cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChoiceCard({
  value,
  selected,
  title,
  badges,
  note,
}: {
  value: string
  selected: boolean
  title: string
  badges?: React.ReactNode
  note?: string
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal",
        selected ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
          {title}
          {badges}
        </span>
        {note && (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {note}
          </span>
        )}
      </span>
    </Label>
  )
}
