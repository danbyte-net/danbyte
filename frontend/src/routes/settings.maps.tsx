import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { useMe } from "@/lib/use-me"
import { Input } from "@/components/ui/input"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
  SettingsRow,
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
        The tile servers behind the Site map - standard and satellite basemaps.
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
      layout="rows"
    >
      <SettingsRow
        label="Tile URL"
        hint="https, with {z}/{x}/{y} placeholders"
        htmlFor="map-tile-url"
      >
        <Input
          id="map-tile-url"
          value={tileUrl}
          onChange={(e) => setTileUrl(e.target.value)}
          placeholder="https://tiles.example.com/{z}/{x}/{y}.png"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </SettingsRow>
      <SettingsRow
        label="Attribution"
        hint="Shown on the map. Most tile providers require it."
        htmlFor="map-tile-attribution"
      >
        <Input
          id="map-tile-attribution"
          value={tileAttrib}
          onChange={(e) => setTileAttrib(e.target.value)}
          placeholder='&copy; <a href="…">My tiles</a>'
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </SettingsRow>
      <SettingsRow
        label="Satellite URL"
        hint="Blank uses Esri World Imagery."
        htmlFor="map-satellite-url"
      >
        <Input
          id="map-satellite-url"
          value={satUrl}
          onChange={(e) => setSatUrl(e.target.value)}
          placeholder="https://tiles.example.com/sat/{z}/{y}/{x}"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </SettingsRow>
      <SettingsRow
        label="Satellite attribution"
        hint="Shown when the satellite basemap is active."
        htmlFor="map-satellite-attribution"
      >
        <Input
          id="map-satellite-attribution"
          value={satAttrib}
          onChange={(e) => setSatAttrib(e.target.value)}
          placeholder="Tiles &copy; Esri …"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </SettingsRow>
      <p className="px-4 py-3 text-[11px] text-muted-foreground">
        A custom tile host also needs to be allowed in the nginx CSP (img-src) -
        see the Site map docs. OpenStreetMap's servers are donation-funded: keep
        the default only for light internal use, per their tile usage policy.
      </p>
    </SettingsCard>
  )
}
