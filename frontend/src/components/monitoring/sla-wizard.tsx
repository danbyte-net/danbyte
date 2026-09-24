import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  CheckListResponse,
  CheckTemplate,
  Paginated,
  SlaAgreement,
  SlaObjectType,
  SlaPeriod,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  CheckList,
  Field,
  FormCombobox,
  FormSection,
  FormSelect,
  FormText,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PERIOD_LABEL } from "./sla-figure"
import { MEMBER_NOUN } from "./sla-drill"

// A new agreement in three steps: what is promised, to what, and which
// checks measure it. Everything else keeps its default and is on the full
// form afterwards.

interface Picked {
  type: SlaObjectType
  id: string
  label: string
}

const STEPS = ["Agreement", "Members", "Checks"] as const

export function SlaWizard({
  onCreated,
  onCancel,
  onFullForm,
}: {
  onCreated: (a: SlaAgreement) => void
  onCancel: () => void
  onFullForm: () => void
}) {
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  // Step 1
  const [name, setName] = useState("")
  const [forKind, setForKind] = useState<"tenant" | "name">("tenant")
  const [forName, setForName] = useState("")
  const [target, setTarget] = useState("99.9")
  const [period, setPeriod] = useState<SlaPeriod>("month")
  // Step 2
  const [kind, setKind] = useState<SlaObjectType>("api.device")
  const [members, setMembers] = useState<Picked[]>([])
  // Step 3
  const [groupName, setGroupName] = useState("Default")
  const [templates, setTemplates] = useState<string[] | null>(null)

  const add = (items: { id: string; label: string }[]) =>
    setMembers((xs) => [
      ...xs,
      ...items
        .filter((i) => !xs.some((x) => x.type === kind && x.id === i.id))
        .map((i) => ({ type: kind, id: i.id, label: i.label })),
    ])

  const vms = useQuery({
    queryKey: ["vms-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/virtual-machines/?picker=1"
      ),
    enabled: kind === "api.virtualmachine",
    staleTime: 5 * 60_000,
  })
  const circuits = useQuery({
    queryKey: ["circuits-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; cid: string; provider: { name: string } }>>(
        "/api/circuits/?page_size=1000"
      ),
    enabled: kind === "api.circuit",
    staleTime: 5 * 60_000,
  })
  const allTemplates =
    useQuery({
      queryKey: ["check-templates", "sla-picker"],
      queryFn: () =>
        api<Paginated<CheckTemplate>>(
          "/api/monitoring/templates/?page_size=500"
        ),
      staleTime: 60_000,
    }).data?.results ?? []

  // The checks the picked devices and prefixes already run: ticked for you.
  const suggestQuery = useMemo(() => {
    const p = new URLSearchParams({ page_size: "500" })
    const devices = members.filter((m) => m.type === "api.device")
    const prefixes = members.filter((m) => m.type === "api.prefix")
    if (devices.length) p.set("device", devices.map((m) => m.id).join(","))
    if (prefixes.length) p.set("prefix", prefixes.map((m) => m.id).join(","))
    return devices.length || prefixes.length ? p.toString() : ""
  }, [members])
  const suggested = useQuery({
    queryKey: ["sla-wizard-suggest", suggestQuery],
    queryFn: () =>
      api<CheckListResponse>(`/api/monitoring/checks/?${suggestQuery}`),
    enabled: step === 2 && !!suggestQuery,
  })
  const suggestedIds = useMemo(
    () => [
      ...new Set((suggested.data?.results ?? []).map((r) => r.template.id)),
    ],
    [suggested.data]
  )
  const picked = templates ?? suggestedIds

  const create = useMutation({
    mutationFn: async () => {
      const a = await api<SlaAgreement>("/api/monitoring/sla-agreements/", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          provided_for: forKind,
          customer_name: forKind === "name" ? forName.trim() : "",
          target_pct: target,
          period,
          status: "active",
        }),
      })
      const group = await api<{ id: string }>(
        "/api/monitoring/sla-check-groups/",
        {
          method: "POST",
          body: JSON.stringify({
            agreement: a.id,
            name: groupName.trim() || "Default",
            items: picked.map((template) => ({
              template,
              counts: true,
              weight: 1,
              required: false,
            })),
          }),
        }
      )
      if (members.length)
        await api("/api/monitoring/sla-members/bulk-add/", {
          method: "POST",
          body: JSON.stringify({
            agreement: a.id,
            group: group.id,
            objects: members.map((m) => ({
              object_type: m.type,
              object_id: m.id,
            })),
          }),
        })
      return a
    },
    onSuccess: (a) => {
      toast.success(`Created ${a.name}`)
      qc.invalidateQueries({ queryKey: ["sla-agreements"] })
      onCreated(a)
    },
    onError: (e) => apiErrorToast(e),
  })

  const ready =
    step === 0
      ? !!name.trim() &&
        Number(target) > 0 &&
        Number(target) < 100 &&
        (forKind === "tenant" || !!forName.trim())
      : true

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {STEPS.map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-muted-foreground">·</span>}
            <span
              className={
                i === step
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              }
            >
              {i + 1}. {s}
            </span>
          </span>
        ))}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="ml-auto"
          onClick={onFullForm}
        >
          All settings
        </Button>
      </div>

      {step === 0 && (
        <FormSection title="Agreement" card>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormText
              label="Name"
              value={name}
              onChange={setName}
              required
              placeholder="Core network"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormSelect
                label="Provided for"
                value={forKind}
                onChange={(v) => setForKind(v as typeof forKind)}
                options={[
                  { value: "tenant", label: "This tenant" },
                  { value: "name", label: "A name" },
                ]}
              />
              {forKind === "name" && (
                <FormText
                  label="Name"
                  value={forName}
                  onChange={setForName}
                  required
                  placeholder="Head office"
                />
              )}
            </div>
            <FormText
              label="Target"
              type="number"
              inputMode="decimal"
              value={target}
              onChange={setTarget}
              info="Availability promised over the period, in percent."
            />
            <FormSelect
              label="Period"
              value={period}
              onChange={(v) => setPeriod(v as SlaPeriod)}
              options={Object.entries(PERIOD_LABEL).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
        </FormSection>
      )}

      {step === 1 && (
        <FormSection title="Members" card>
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <FormSelect
                label="Kind"
                value={kind}
                onChange={(v) => setKind(v as SlaObjectType)}
                options={[
                  { value: "api.device", label: "Devices" },
                  { value: "api.virtualmachine", label: "Virtual machines" },
                  { value: "api.ipaddress", label: "IP addresses" },
                  { value: "api.prefix", label: "Prefixes" },
                  { value: "api.circuit", label: "Circuits" },
                ]}
              />
              {kind === "api.device" && (
                <DevicePicker
                  value={null}
                  onChange={() => undefined}
                  onPickMany={add}
                />
              )}
              {kind === "api.ipaddress" && (
                <IpPicker
                  value={null}
                  onChange={() => undefined}
                  onPickMany={add}
                />
              )}
              {kind === "api.prefix" && (
                <PrefixPicker
                  value={null}
                  onChange={() => undefined}
                  onPickMany={add}
                />
              )}
              {kind === "api.virtualmachine" && (
                <FormCombobox
                  label="Virtual machine"
                  value={null}
                  onChange={(id) => {
                    const vm = vms.data?.results.find((v) => v.id === id)
                    if (vm) add([{ id: vm.id, label: vm.name }])
                  }}
                  options={(vms.data?.results ?? []).map((v) => ({
                    value: v.id,
                    label: v.name,
                  }))}
                  placeholder="Add a VM"
                  searchPlaceholder="Search VMs…"
                  emptyText="No virtual machines."
                />
              )}
              {kind === "api.circuit" && (
                <FormCombobox
                  label="Circuit"
                  value={null}
                  onChange={(id) => {
                    const c = circuits.data?.results.find((x) => x.id === id)
                    if (c) add([{ id: c.id, label: c.cid }])
                  }}
                  options={(circuits.data?.results ?? []).map((c) => ({
                    value: c.id,
                    label: c.cid,
                    hint: c.provider.name,
                  }))}
                  placeholder="Add a circuit"
                  searchPlaceholder="Search circuits…"
                  emptyText="No circuits."
                />
              )}
            </div>
            {members.length ? (
              <div className="flex flex-wrap gap-1.5">
                {members.map((m) => (
                  <Badge
                    key={`${m.type}-${m.id}`}
                    variant="secondary"
                    className="gap-1"
                  >
                    <span className="text-muted-foreground">
                      {MEMBER_NOUN[m.type]}
                    </span>
                    {m.label}
                    <button
                      type="button"
                      aria-label={`Remove ${m.label}`}
                      onClick={() =>
                        setMembers((xs) =>
                          xs.filter(
                            (x) => !(x.type === m.type && x.id === m.id)
                          )
                        )
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                None yet. Members can also be added later.
              </p>
            )}
          </div>
        </FormSection>
      )}

      {step === 2 && (
        <FormSection title="Checks" card>
          <div className="grid gap-3">
            <FormText
              label="Check group"
              value={groupName}
              onChange={setGroupName}
              info="The members' class of equipment, such as Leaf switches. More groups can be added later."
            />
            <Field
              label="Checks that count"
              info="Ticked: the checks your members already run. With none ticked, every check on a member's addresses counts."
            >
              <CheckList
                options={allTemplates.map((t) => ({
                  value: t.id,
                  label: t.name,
                  hint: t.kind.toUpperCase(),
                }))}
                value={picked}
                onChange={setTemplates}
                className="max-h-56"
                empty="No check templates yet."
              />
            </Field>
          </div>
        </FormSection>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {step > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep((s) => s - 1)}
          >
            Back
          </Button>
        )}
        {step < STEPS.length - 1 ? (
          <Button
            type="button"
            disabled={!ready}
            onClick={() => setStep((s) => s + 1)}
          >
            Next
          </Button>
        ) : (
          <Button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating..." : "Create"}
          </Button>
        )}
      </div>
    </div>
  )
}
