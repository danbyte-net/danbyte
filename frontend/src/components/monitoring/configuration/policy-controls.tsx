import { type ReactNode } from "react"
import {
  Check,
  ChevronDown,
  Crosshair,
  ListChecks,
  ScanSearch,
  Settings2,
} from "lucide-react"

import type {
  CheckTemplate,
  MonitoringPolicy,
  MonitoringProfile,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"

export type SavePolicy<T extends { id: string }> = (args: {
  row: T
  patch: Partial<MonitoringPolicy>
}) => void

// Stateless — the toggle states derive purely from the policy/prefix caches,
// which usePolicySave/usePrefixDiscoverToggle patch optimistically (and roll
// back on error). Local-state + sync-useEffect pairs here cost an extra
// render pass per row on every parent update, ×500 on the prefix tab.
export function PolicyControls<T extends { id: string }>({
  policy,
  row,
  templates,
  profiles,
  save,
  pending,
  showTarget,
  discover,
}: {
  policy: MonitoringPolicy | undefined
  row: T
  templates: CheckTemplate[]
  profiles: MonitoringProfile[]
  save: SavePolicy<T>
  /** This row's policy save is in flight — spinner on the Monitor button. */
  pending?: boolean
  /** Device/type/role scopes: show the "which IPs" target picker. */
  showTarget?: boolean
  discover?: {
    active: boolean
    disabled?: boolean
    /** This row's discover toggle is in flight — spinner on the button. */
    pending?: boolean
    onClick: () => void
  }
}) {
  const inherited = policy?.inherit ?? true
  const enabled = policy ? policy.enabled : false
  const monitoringActive = enabled && !inherited

  // Same on/off treatment as the prefix page's "Auto-discover" button:
  // filled primary when active, outline when off, spinner while saving.
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        variant={monitoringActive ? "default" : "outline"}
        size="sm"
        disabled={pending}
        title={monitoringActive ? "Disable monitoring" : "Enable monitoring"}
        onClick={() =>
          save({
            row,
            patch: { enabled: !monitoringActive, inherit: false },
          })
        }
      >
        {pending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Check data-icon="inline-start" />
        )}
        <span>Monitor</span>
      </Button>
      {discover && (
        <Button
          type="button"
          variant={discover.active ? "default" : "outline"}
          size="sm"
          disabled={discover.disabled || discover.pending}
          title="Periodically discover IPs in this subnet"
          onClick={discover.onClick}
        >
          {discover.pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ScanSearch data-icon="inline-start" />
          )}
          <span>Discover</span>
        </Button>
      )}
      {showTarget && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Which of the device's IPs these checks run against"
            >
              <Crosshair data-icon="inline-start" />
              <span>{targetLabel(policy?.target)}</span>
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Apply to</DropdownMenuLabel>
            {TARGET_OPTIONS.map((opt) => (
              <DropdownCheckItem
                key={opt.value}
                checked={(policy?.target ?? "all") === opt.value}
                onCheckedChange={() =>
                  save({ row, patch: { target: opt.value } })
                }
              >
                {opt.label}
              </DropdownCheckItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            title="Profiles, templates, and inheritance"
          >
            <ListChecks data-icon="inline-start" />
            <span>{policySummary(policy)}</span>
            {policy?.interval_seconds != null && (
              <span className="text-muted-foreground">
                · {freqShort(policy.interval_seconds)}
              </span>
            )}
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Policy</DropdownMenuLabel>
          <DropdownCheckItem
            checked={inherited}
            onCheckedChange={(checked) =>
              save({ row, patch: { inherit: checked, enabled: true } })
            }
          >
            Follow global
          </DropdownCheckItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Frequency</DropdownMenuLabel>
          {FREQ_OPTIONS.map((opt) => (
            <DropdownCheckItem
              key={opt.label}
              checked={(policy?.interval_seconds ?? null) === opt.value}
              onCheckedChange={() =>
                save({ row, patch: { interval_seconds: opt.value } })
              }
            >
              {opt.label}
            </DropdownCheckItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Profiles</DropdownMenuLabel>
          {profiles.length === 0 ? (
            <DropdownMenuItem disabled>No profiles</DropdownMenuItem>
          ) : (
            profiles.map((profile) => (
              <DropdownCheckItem
                key={profile.id}
                checked={(policy?.profiles ?? []).includes(profile.id)}
                onCheckedChange={(checked) =>
                  save({
                    row,
                    patch: {
                      enabled: true,
                      profiles: toggleId(
                        policy?.profiles ?? [],
                        profile.id,
                        !!checked
                      ),
                    },
                  })
                }
              >
                {profile.name}
              </DropdownCheckItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Templates</DropdownMenuLabel>
          {templates.length === 0 ? (
            <DropdownMenuItem disabled>No templates</DropdownMenuItem>
          ) : (
            templates.map((template) => (
              <DropdownCheckItem
                key={template.id}
                checked={(policy?.templates ?? []).includes(template.id)}
                onCheckedChange={(checked) =>
                  save({
                    row,
                    patch: {
                      enabled: true,
                      templates: toggleId(
                        policy?.templates ?? [],
                        template.id,
                        !!checked
                      ),
                    },
                  })
                }
              >
                <span>{template.name}</span>
                <Badge variant="secondary" className="ml-auto text-[10px]">
                  {template.kind}
                </Badge>
              </DropdownCheckItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function TemplateMenu({
  templates,
  selected,
  onChange,
}: {
  templates: CheckTemplate[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Settings2 data-icon="inline-start" />
          {selected.length
            ? `${selected.length} template${selected.length === 1 ? "" : "s"}`
            : "Templates"}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {templates.length === 0 ? (
          <DropdownMenuItem disabled>No templates</DropdownMenuItem>
        ) : (
          templates.map((template) => (
            <DropdownCheckItem
              key={template.id}
              checked={selected.includes(template.id)}
              onCheckedChange={(checked) =>
                onChange(toggleId(selected, template.id, checked))
              }
            >
              <span>{template.name}</span>
              <Badge variant="secondary" className="ml-auto text-[10px]">
                {template.kind}
              </Badge>
            </DropdownCheckItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DropdownCheckItem({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
}) {
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault()
        onCheckedChange(!checked)
      }}
      className="gap-2 pr-2"
    >
      <Checkbox
        checked={checked}
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none"
      />
      {children}
    </DropdownMenuItem>
  )
}

function toggleId(selected: string[], id: string, checked: boolean) {
  if (checked) return selected.includes(id) ? selected : [...selected, id]
  return selected.filter((item) => item !== id)
}

// Two-level frequency: null = follow the tenant's global default interval;
// a number overrides it for this scope. Mirrors the backend NAMED_INTERVALS.
const FREQ_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Follow global default", value: null },
  { label: "Every 1 min", value: 60 },
  { label: "Every 5 min", value: 300 },
  { label: "Every 15 min", value: 900 },
  { label: "Every 30 min", value: 1800 },
  { label: "Hourly", value: 3600 },
  { label: "Every 6 h", value: 21600 },
  { label: "Daily", value: 86400 },
]

// Which of a device's IPs a device/type/role policy targets. Mirrors the
// backend MonitoringPolicy.TARGET_CHOICES.
type PolicyTarget = MonitoringPolicy["target"]
const TARGET_OPTIONS: { label: string; value: PolicyTarget }[] = [
  { label: "All IPs", value: "all" },
  { label: "Interface IPs", value: "interfaces" },
  { label: "Primary IP", value: "primary" },
  { label: "OOB / management IP", value: "oob" },
]

function targetLabel(target: PolicyTarget | undefined): string {
  return (
    TARGET_OPTIONS.find((o) => o.value === (target ?? "all"))?.label ??
    "All IPs"
  )
}

/** Compact interval label for the dropdown button (e.g. 900 → "15m"). */
function freqShort(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function policySummary(policy: MonitoringPolicy | undefined) {
  if (!policy) return "Follow global"
  if (policy.inherit) return "Follow global"
  if (!policy.enabled) return "Disabled"
  const count = policy.profiles.length + policy.templates.length
  // An enabled custom policy with nothing selected falls back to a default
  // reachability ping (see resolver.default_ping_template) — say so plainly
  // instead of the opaque "Custom".
  return count ? `${count} item${count === 1 ? "" : "s"}` : "Ping"
}
