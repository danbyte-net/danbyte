import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { useMe } from "@/lib/use-me"
import { Field } from "@/components/forms"
import { Input } from "@/components/ui/input"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"

export const Route = createFileRoute("/settings/maps")({
  component: MapsPage,
})

function MapsPage() {
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
      <SettingsHeader title="Maps">
        The tile servers behind the Site map — standard and satellite basemaps.
      </SettingsHeader>
      <SettingsGrid>
        <MapTilesCard />
      </SettingsGrid>
    </div>
  )
}

function MapTilesCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [tileUrl, setTileUrl] = useState("")
  const [tileAttrib, setTileAttrib] = useState("")
  const [satUrl, setSatUrl] = useState("")
  const [satAttrib, setSatAttrib] = useState("")

  useEffect(() => {
    if (data) {
      setTileUrl(data.map_tile_url ?? "")
      setTileAttrib(data.map_tile_attribution ?? "")
      setSatUrl(data.map_satellite_url ?? "")
      setSatAttrib(data.map_satellite_attribution ?? "")
    }
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Map tiles"
      description="The tile server behind the Site map. Blank = OpenStreetMap's standard tiles (fine for light use; run your own tile server for heavy or offline deployments)."
      onSave={() =>
        save.mutate({
          key: "tiles",
          patch: {
            map_tile_url: tileUrl.trim(),
            map_tile_attribution: tileAttrib.trim(),
            map_satellite_url: satUrl.trim(),
            map_satellite_attribution: satAttrib.trim(),
          },
        })
      }
      dirty={
        tileUrl !== (data.map_tile_url ?? "") ||
        tileAttrib !== (data.map_tile_attribution ?? "") ||
        satUrl !== (data.map_satellite_url ?? "") ||
        satAttrib !== (data.map_satellite_attribution ?? "")
      }
      saving={savingKey === "tiles"}
      saveLabel="Save map tiles"
    >
      <Field
        label="Tile URL template"
        hint="https, with {z}/{x}/{y} placeholders"
      >
        <Input
          value={tileUrl}
          onChange={(e) => setTileUrl(e.target.value)}
          placeholder="https://tiles.example.com/{z}/{x}/{y}.png"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Attribution"
        hint="shown on the map — required by most tile providers"
      >
        <Input
          value={tileAttrib}
          onChange={(e) => setTileAttrib(e.target.value)}
          placeholder='&copy; <a href="…">My tiles</a>'
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Satellite tile URL template"
        hint="blank = Esri World Imagery"
      >
        <Input
          value={satUrl}
          onChange={(e) => setSatUrl(e.target.value)}
          placeholder="https://tiles.example.com/sat/{z}/{y}/{x}"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Satellite attribution"
        hint="shown when the satellite basemap is active"
      >
        <Input
          value={satAttrib}
          onChange={(e) => setSatAttrib(e.target.value)}
          placeholder="Tiles &copy; Esri …"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </Field>
      <p className="text-[11px] text-muted-foreground">
        A custom tile host also needs to be allowed in the nginx CSP (img-src) —
        see the Site map docs. OpenStreetMap's servers are donation-funded: keep
        the default only for light internal use, per their tile usage policy.
      </p>
    </SettingsCard>
  )
}
