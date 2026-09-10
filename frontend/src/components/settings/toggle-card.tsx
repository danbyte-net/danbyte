import { cardAnchor } from "@/components/settings/settings-card"
import { Badge } from "@/components/ui/badge"
import { InfoTip } from "@/components/ui/info-tip"
import { Switch } from "@/components/ui/switch"

/**
 * One switchable thing, as a card.
 *
 * Integrations and plugins are the same object to an operator - something
 * Danbyte can do that is off until you turn it on - so they are one card,
 * shown on one page, rather than two lists on two pages that happen to both
 * carry a switch.
 *
 * The logo slot, the status pill and the footer action stay in the same place
 * on every card, so a grid of them reads as a grid rather than as a pile.
 */
export function ToggleCard({
  title,
  info,
  subtitle,
  description,
  logo,
  checked,
  onCheckedChange,
  disabled,
  /** Replaces the On/Off pill - for a card that cannot be switched at all. */
  status,
  /** Extra pills beside the status, e.g. a plugin's version or load state. */
  badges,
  /** Footer control, right-aligned: a link to the connection, an Uninstall. */
  action,
}: {
  title: string
  info?: React.ReactNode
  subtitle?: React.ReactNode
  description: React.ReactNode
  logo?: React.ReactNode
  checked: boolean
  onCheckedChange?: (v: boolean) => void
  disabled?: boolean
  status?: React.ReactNode
  badges?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section
      // The same anchor SettingsCard derives, so a search result scrolls to
      // the card rather than the page top.
      id={cardAnchor(title)}
      className="flex scroll-mt-6 flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex items-start gap-3">
        {logo}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[13px] font-semibold">{title}</h2>
            {info && <InfoTip>{info}</InfoTip>}
          </div>
          {subtitle && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        {onCheckedChange && (
          <Switch
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            aria-label={title}
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground">{description}</p>

      <div className="mt-auto flex items-center gap-2 pt-1">
        {status ?? (
          <Badge variant={checked ? "success" : "secondary"}>
            {checked ? "On" : "Off"}
          </Badge>
        )}
        {badges}
        {action && <span className="ml-auto">{action}</span>}
      </div>
    </section>
  )
}

/** The grid the cards flow into. One place, so both sections match. */
export function ToggleCardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  )
}
