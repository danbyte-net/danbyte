import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { useMe } from "@/lib/use-me"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { MapLabelLanguage } from "@/lib/api"
import { LABEL_LANGUAGE_OPTIONS } from "@/components/site-map/vector-style"
import { InfoTip } from "@/components/ui/info-tip"
import { Loading } from "@/components/loading"
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
  if (isLoading) return <Loading />
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
      <SettingsHeader title="Site map">
        The Site map's street and satellite basemaps.
      </SettingsHeader>
      <SettingsGrid>
        <BasemapCard />
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
      badge={
        <InfoTip>
          OpenStreetMap&rsquo;s servers are donation-funded: keep the default
          only for light internal use, per their tile usage policy, and run your
          own tile server for heavy or offline deployments. A custom tile host
          must also be allowed in the nginx CSP (img-src); see the Site map
          docs.
        </InfoTip>
      }
      description="Raster tiles. Blank uses OpenStreetMap's standard tiles."
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
    </SettingsCard>
  )
}

// #467: vector tiles are drawn by the browser with the style that ships with
// Danbyte, so the labels can be in the reader's language.
function BasemapCard() {
  const qc = useQueryClient()
  const { data, save, savingKey } = useDeploymentSettings()
  const [kind, setKind] = useState<"raster" | "vector">("raster")
  const [url, setUrl] = useState("")
  const [attrib, setAttrib] = useState("")
  const [labels, setLabels] = useState<MapLabelLanguage>("en")

  useEffect(() => {
    if (data) {
      setKind(data.map_basemap ?? "raster")
      setUrl(data.map_vector_url ?? "")
      setAttrib(data.map_vector_attribution ?? "")
      setLabels(data.map_label_language ?? "en")
    }
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Basemap"
      badge={
        <InfoTip>
          Vector tiles are drawn in the browser, so labels can be in English,
          the local script or the reader&rsquo;s language. The style and fonts
          ship with Danbyte; only the tile host is contacted, and it must be
          allowed in the nginx CSP (connect-src). The default source is the
          OpenStreetMap Foundation&rsquo;s vector tiles, for light use per their
          usage policy. Browsers without WebGL get the raster tiles.
        </InfoTip>
      }
      description="Street map drawn from raster or vector tiles."
      onSave={() =>
        save.mutate(
          {
            key: "basemap",
            patch: {
              map_basemap: kind,
              map_vector_url: url.trim(),
              map_vector_attribution: attrib.trim(),
              map_label_language: labels,
            },
          },
          { onSuccess: () => qc.invalidateQueries({ queryKey: ["site-map"] }) }
        )
      }
      dirty={
        kind !== data.map_basemap ||
        url !== (data.map_vector_url ?? "") ||
        attrib !== (data.map_vector_attribution ?? "") ||
        labels !== data.map_label_language
      }
      saving={savingKey === "basemap"}
      saveLabel="Save basemap"
      layout="rows"
    >
      <SettingsRow label="Basemap" htmlFor="map-basemap">
        <Select
          value={kind}
          onValueChange={(v) => setKind(v as "raster" | "vector")}
        >
          <SelectTrigger id="map-basemap" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="vector">Vector tiles</SelectItem>
            <SelectItem value="raster">Raster tiles</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        label="Vector source"
        hint="TileJSON or style URL, https"
        htmlFor="map-vector-url"
      >
        <Input
          id="map-vector-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://vector.openstreetmap.org/shortbread_v1/tilejson.json"
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </SettingsRow>
      <SettingsRow
        label="Attribution"
        hint="Blank uses the OpenStreetMap credit"
        htmlFor="map-vector-attribution"
      >
        <Input
          id="map-vector-attribution"
          value={attrib}
          onChange={(e) => setAttrib(e.target.value)}
          placeholder='&copy; <a href="…">My tiles</a>'
          className="font-mono text-[12px]"
          spellCheck={false}
        />
      </SettingsRow>
      <SettingsRow
        label="Label language"
        hint="Default; users can change it"
        htmlFor="map-label-language"
      >
        <Select
          value={labels}
          onValueChange={(v) => setLabels(v as MapLabelLanguage)}
        >
          <SelectTrigger id="map-label-language" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LABEL_LANGUAGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsCard>
  )
}
