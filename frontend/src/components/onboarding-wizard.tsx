import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Check, Rocket } from "lucide-react"

import { api } from "@/lib/api"
import type { Me, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCombobox, FormText, useFieldErrors } from "@/components/forms"

/**
 * First-run setup wizard (skippable). Mounted once in the app shell; opens when
 * a tenant is fresh (`me.onboarding_dismissed === false` and it has no sites).
 * Walks the user through creating their first Site → Location → VLAN → Prefix →
 * Device via the normal create endpoints, threading the created site id forward.
 * "Skip" and "Finish" both persist the dismissed flag so it never reopens.
 */
const STEPS = [
  "Welcome",
  "Site",
  "Location",
  "VLAN",
  "Prefix",
  "Device",
  "Done",
] as const
type StepName = (typeof STEPS)[number]

const OPEN_EVENT = "danbyte:open-onboarding"

/** Force the first-run wizard open from anywhere (e.g. a settings "re-run"
 * button), bypassing the fresh-install auto-trigger. */
export function openOnboardingWizard() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function OnboardingWizard({ me }: { me: Me }) {
  const qc = useQueryClient()

  // Auto-trigger only for a genuinely fresh tenant. Skip the fetch entirely once
  // the flag is dismissed — a re-run comes through the window event instead.
  const enabled = me.is_authenticated && me.onboarding_dismissed === false
  // …and only for a user who can actually create the objects the wizard makes;
  // otherwise every step's Create button 403s. Site is the anchor, so gate on
  // add-site. Re-run (the window event) still force-opens it for anyone.
  const canCreate =
    !!me.is_superuser || (me.permissions?.site ?? []).includes("add")
  const state = useQuery({
    queryKey: ["onboarding"],
    queryFn: () =>
      api<{ dismissed: boolean; has_sites: boolean }>("/api/onboarding/"),
    enabled: enabled && canCreate,
    staleTime: Infinity,
  })

  // `opened` LATCHES: once the wizard opens (fresh tenant, or a re-run event)
  // it stays open until the user skips/finishes. Without this it would slam shut
  // the moment step 1 creates the first site (has_sites flips true).
  const [opened, setOpened] = useState(false)
  const autoOpen =
    enabled &&
    canCreate &&
    state.data != null &&
    !state.data.dismissed &&
    !state.data.has_sites
  useEffect(() => {
    if (autoOpen) setOpened(true)
  }, [autoOpen])
  useEffect(() => {
    const h = () => setOpened(true)
    window.addEventListener(OPEN_EVENT, h)
    return () => window.removeEventListener(OPEN_EVENT, h)
  }, [])

  if (!opened) return null

  return (
    <WizardDialog
      onClose={() => {
        setOpened(false)
        // Persist so it never auto-reopens; refresh me + onboarding state.
        api("/api/onboarding/", { method: "POST" })
          .then(() => {
            qc.invalidateQueries({ queryKey: ["me"] })
            qc.invalidateQueries({ queryKey: ["onboarding"] })
          })
          .catch(() => {})
      }}
    />
  )
}

interface DeviceRoleOption {
  id: string
  name: string
}

function WizardDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [stepIdx, setStepIdx] = useState(0)
  const step: StepName = STEPS[stepIdx]
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  // Collected state.
  const [siteName, setSiteName] = useState("")
  const [siteId, setSiteId] = useState<string | null>(null)
  const [locName, setLocName] = useState("")
  const [vlanId, setVlanId] = useState("")
  const [vlanName, setVlanName] = useState("")
  const [vlanPk, setVlanPk] = useState<string | null>(null)
  const [cidr, setCidr] = useState("")
  const [devName, setDevName] = useState("")
  const [roleId, setRoleId] = useState<string | null>(null)
  const [created, setCreated] = useState<string[]>([])

  const roles = useQuery({
    queryKey: ["device-roles", "picker"],
    queryFn: () =>
      api<Paginated<DeviceRoleOption>>(
        "/api/device-roles/?picker=1&page_size=200"
      ),
    enabled: step === "Device",
  })
  const roleOptions = useMemo(
    () =>
      (roles.data?.results ?? []).map((r) => ({ value: r.id, label: r.name })),
    [roles.data]
  )

  const note = (label: string) => setCreated((c) => [...c, label])
  const goto = (i: number) => {
    reset()
    setStepIdx(i)
  }

  // The mutation for the CURRENT data step. Resolves true on success (advance),
  // false on validation error (stay and show field errors).
  const submit = useMutation({
    mutationFn: async (): Promise<boolean> => {
      try {
        if (step === "Site") {
          const s = await api<{ id: string }>("/api/sites/", {
            method: "POST",
            body: JSON.stringify({ name: siteName.trim() }),
          })
          setSiteId(s.id)
          note(`Site “${siteName.trim()}”`)
        } else if (step === "Location") {
          await api("/api/locations/", {
            method: "POST",
            body: JSON.stringify({ name: locName.trim(), site_id: siteId }),
          })
          note(`Location “${locName.trim()}”`)
        } else if (step === "VLAN") {
          const v = await api<{ id: string }>("/api/vlans/", {
            method: "POST",
            body: JSON.stringify({
              vlan_id: Number(vlanId),
              name: vlanName.trim(),
              site_id: siteId,
            }),
          })
          setVlanPk(v.id)
          note(`VLAN ${vlanId} “${vlanName.trim()}”`)
        } else if (step === "Prefix") {
          await api("/api/prefixes/", {
            method: "POST",
            body: JSON.stringify({
              cidr: cidr.trim(),
              site_id: siteId,
              vlan_id: vlanPk,
            }),
          })
          note(`Prefix ${cidr.trim()}`)
        } else if (step === "Device") {
          await api("/api/devices/", {
            method: "POST",
            body: JSON.stringify({
              name: devName.trim(),
              site_id: siteId,
              role_id: roleId,
            }),
          })
          note(`Device “${devName.trim()}”`)
        }
        return true
      } catch (e) {
        // 400s map to inline field errors; a 403/500/network error wouldn't,
        // so also toast so the button doesn't just silently re-enable.
        handleApiError(e)
        apiErrorToast(e)
        return false
      }
    },
    onSuccess: (ok) => {
      if (ok) {
        // The lists this wizard just added to should refetch.
        qc.invalidateQueries()
        goto(stepIdx + 1)
      }
    },
  })

  // Whether the current step's required fields are filled.
  const canSubmit =
    (step === "Site" && siteName.trim() !== "") ||
    (step === "Location" && locName.trim() !== "") ||
    (step === "VLAN" && vlanId.trim() !== "" && vlanName.trim() !== "") ||
    (step === "Prefix" && cidr.trim() !== "") ||
    (step === "Device" && devName.trim() !== "")

  const isOptional =
    step === "Location" ||
    step === "VLAN" ||
    step === "Prefix" ||
    step === "Device"

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-primary" />
            {step === "Welcome"
              ? "Welcome to Danbyte"
              : step === "Done"
                ? "You're all set"
                : "First-time setup"}
          </DialogTitle>
          {step !== "Welcome" && step !== "Done" && (
            <DialogDescription>
              Step {stepIdx} of {STEPS.length - 2} — create your first{" "}
              {step.toLowerCase()}. You can skip any of these and add them
              later.
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Progress dots for the data steps. */}
        {step !== "Welcome" && step !== "Done" && (
          <ol className="flex flex-wrap gap-1.5">
            {STEPS.slice(1, -1).map((s, i) => {
              const n = i + 1
              const active = n === stepIdx
              const done = n < stepIdx
              return (
                <li
                  key={s}
                  className={
                    "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] " +
                    (active
                      ? "border-primary text-foreground"
                      : done
                        ? "border-border text-muted-foreground"
                        : "border-border text-muted-foreground/60")
                  }
                >
                  {done ? <Check className="h-3 w-3" /> : null}
                  {s}
                </li>
              )
            })}
          </ol>
        )}

        <div className="min-h-[7rem] py-1">
          {step === "Welcome" && (
            <p className="text-sm text-muted-foreground">
              Let's get your instance going with the essentials — a{" "}
              <span className="font-medium text-foreground">site</span>, an
              optional location, a VLAN, an IP prefix, and a first device. It
              takes under a minute, and you can skip anything.
            </p>
          )}

          {step === "Site" && (
            <FormText
              label="Site name"
              value={siteName}
              onChange={setSiteName}
              placeholder="HQ, DC-1, HomeLab…"
              error={fieldErrors.name}
              required
              autoFocus
            />
          )}

          {step === "Location" && (
            <FormText
              label="Location name"
              hint="A room, floor, or area inside the site (optional)"
              value={locName}
              onChange={setLocName}
              placeholder="Server room, Floor 2…"
              error={fieldErrors.name}
              autoFocus
            />
          )}

          {step === "VLAN" && (
            <div className="grid grid-cols-[7rem_1fr] gap-3">
              <FormText
                label="VLAN ID"
                type="number"
                value={vlanId}
                onChange={setVlanId}
                placeholder="10"
                error={fieldErrors.vlan_id}
                autoFocus
              />
              <FormText
                label="Name"
                value={vlanName}
                onChange={setVlanName}
                placeholder="servers, mgmt…"
                error={fieldErrors.name}
              />
            </div>
          )}

          {step === "Prefix" && (
            <FormText
              label="Prefix (CIDR)"
              hint="An IP range — links to the VLAN above when set"
              value={cidr}
              onChange={setCidr}
              placeholder="10.0.0.0/24"
              error={fieldErrors.cidr}
              mono
              autoFocus
            />
          )}

          {step === "Device" && (
            <div className="space-y-3">
              <FormText
                label="Device name"
                value={devName}
                onChange={setDevName}
                placeholder="sw-01, pve-01…"
                error={fieldErrors.name}
                autoFocus
              />
              {roleOptions.length > 0 && (
                <FormCombobox
                  label="Role"
                  value={roleId}
                  onChange={setRoleId}
                  options={roleOptions}
                  noneLabel="No role"
                  placeholder="Optional — pick a role"
                />
              )}
            </div>
          )}

          {step === "Done" && (
            <div className="space-y-2 text-sm">
              {created.length > 0 ? (
                <>
                  <p className="text-foreground">Created:</p>
                  <ul className="space-y-1">
                    {created.map((c) => (
                      <li
                        key={c}
                        className="flex items-center gap-2 text-muted-foreground"
                      >
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        {c}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-muted-foreground">
                  No problem — you can add sites, prefixes and devices any time
                  from the sidebar.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap justify-between gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose}>
            {step === "Done" ? "Close" : "Skip setup"}
          </Button>
          <div className="flex gap-2">
            {step === "Welcome" && (
              <Button onClick={() => goto(1)}>
                Let's go <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
            {step !== "Welcome" && step !== "Done" && (
              <>
                {isOptional && (
                  <Button variant="outline" onClick={() => goto(stepIdx + 1)}>
                    Skip
                  </Button>
                )}
                <Button
                  disabled={!canSubmit || submit.isPending}
                  onClick={() => submit.mutate()}
                >
                  {submit.isPending
                    ? "Saving…"
                    : stepIdx === STEPS.length - 2
                      ? "Create"
                      : "Create & next"}
                </Button>
              </>
            )}
            {step === "Done" && <Button onClick={onClose}>Finish</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
