import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { useMe } from "@/lib/use-me"
import { FormCheckbox } from "@/components/forms"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"

export const Route = createFileRoute("/settings/sites")({
  component: SitesPage,
})

function SitesPage() {
  const { canManageDeployment, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment) {
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage deployment settings.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <SettingsHeader title="Sites &amp; separation">
        How sites behave for site-scoped users, and what local site admins may
        manage themselves.
      </SettingsHeader>
      <SettingsGrid>
        <SeparationCard />
        <DelegationCard />
      </SettingsGrid>
    </div>
  )
}

function SeparationCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [separation, setSeparation] = useState(false)
  const [siteSettings, setSiteSettings] = useState(false)

  useEffect(() => {
    if (data) {
      setSeparation(data.enhanced_site_separation)
      setSiteSettings(data.allow_site_settings)
    }
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Site separation"
      description="Deployment default — tenants can override it under This tenant → General."
      onSave={() =>
        save.mutate({
          key: "separation",
          patch: {
            enhanced_site_separation: separation,
            allow_site_settings: siteSettings,
          },
        })
      }
      dirty={
        separation !== data.enhanced_site_separation ||
        siteSettings !== data.allow_site_settings
      }
      saving={savingKey === "separation"}
      saveLabel="Save separation"
    >
      <FormCheckbox
        label="Enhanced site separation"
        checked={separation}
        onChange={setSeparation}
        hint="Each site behaves like a mini-tenant for site-scoped users: pickers offer only their sites, new objects default there, shared (site-less) objects stay read-only. Admins and cross-site users are unaffected."
      />
      <FormCheckbox
        label="Let site admins manage their site's settings"
        checked={siteSettings}
        onChange={setSiteSettings}
        hint="Site editors (and holders of a sitesettings grant) get a Settings → This site section — e.g. their own email delivery."
      />
    </SettingsCard>
  )
}

function DelegationCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [delegate, setDelegate] = useState(false)

  useEffect(() => {
    if (data) setDelegate(data.allow_site_editor_delegation)
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Delegation"
      description="Opt-in features, off by default."
      onSave={() =>
        save.mutate({
          key: "sharing",
          patch: { allow_site_editor_delegation: delegate },
        })
      }
      dirty={delegate !== data.allow_site_editor_delegation}
      saving={savingKey === "sharing"}
      saveLabel="Save delegation"
    >
      <FormCheckbox
        label="Let site editors invite their own viewers"
        checked={delegate}
        onChange={setDelegate}
        hint="A local site editor may grant read-only access to the site(s) they edit — never editors, never other sites."
      />
    </SettingsCard>
  )
}
