import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ReportCoverStyle, TenantSettings } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Field } from "@/components/forms"
import { FormColor } from "@/components/forms/color"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { SettingsCard } from "@/components/settings/settings-card"
import { Button } from "@/components/ui/button"
import { COLOR_PRESETS } from "@/components/ui/color-picker"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * The PDF report cover's look for this tenant (api/report_cover.py): a
 * full-page background - rolling waves in three colours, the plain horizon
 * colour, the uploaded image or none - behind white text. Every report's
 * cover in the tenant follows it; a report picks only its text and, if it
 * wants, another background. The thumbnail is a mock drawn here, not a
 * render.
 */

const COVER_PATH = "/api/tenant-settings/report-cover/"

type Colours = { horizon: string; wave: string; crest: string }

/** The palette families of the colour picker, in its order (five shades
 * each, 400 to 900), the neutrals last. */
const FAMILIES = [
  "Red",
  "Orange",
  "Amber",
  "Yellow",
  "Lime",
  "Green",
  "Emerald",
  "Teal",
  "Cyan",
  "Sky",
  "Blue",
  "Indigo",
  "Violet",
  "Purple",
  "Fuchsia",
  "Pink",
  "Rose",
  "Zinc",
]

/** The colour presets: Danbyte's own blue (the default), then each palette
 * family - its darkest shade for the horizon, its 600 for the waves, white
 * crests. */
export const COVER_PRESETS: ({ key: string; label: string } & Colours)[] = [
  {
    key: "danbyte",
    label: "Danbyte",
    horizon: "#063d66",
    wave: "#0b6fb0",
    crest: "#ffffff",
  },
  ...FAMILIES.map((label, i) => ({
    key: label.toLowerCase(),
    label,
    horizon: COLOR_PRESETS[i * 5 + 4],
    wave: COLOR_PRESETS[i * 5 + 2],
    crest: "#ffffff",
  })),
]

/** A small cover, drawn from the settings. */
export function CoverPreview({
  style,
  horizon,
  wave,
  crest,
  imageUrl,
}: {
  style: ReportCoverStyle
  imageUrl: string | null
} & Colours) {
  const W = 210
  const H = 297
  const shown = style === "upload" && !imageUrl ? "waves" : style
  const dark = shown !== "none"
  const ink = dark ? "#ffffff" : "#18181b"
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-36 shrink-0 rounded-md border bg-white"
      role="img"
      aria-label="Cover preview"
      data-part="cover-preview"
    >
      <defs>
        <linearGradient id="cover-preview-waves" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={horizon} />
          <stop offset="0.55" stopColor={wave} stopOpacity={0.9} />
          <stop offset="1" stopColor={crest} stopOpacity={0.55} />
        </linearGradient>
      </defs>
      {shown === "waves" && (
        <>
          <rect width={W} height={H} fill={horizon} />
          <rect width={W} height={H} fill="url(#cover-preview-waves)" />
          <path
            d={`M0 ${H * 0.5} C${W * 0.3} ${H * 0.4} ${W * 0.6} ${H * 0.55} ${W} ${H * 0.45} L${W} ${H} L0 ${H} Z`}
            fill={horizon}
            fillOpacity={0.25}
          />
        </>
      )}
      {shown === "plain" && <rect width={W} height={H} fill={horizon} />}
      {shown === "upload" && imageUrl && (
        <image
          href={imageUrl}
          width={W}
          height={H}
          preserveAspectRatio="xMidYMid slice"
        />
      )}
      <rect x={19} y={19} width={52} height={7} rx={1} fill={ink} />
      <rect
        x={19}
        y={33}
        width={W - 38}
        height={0.6}
        fill={ink}
        fillOpacity={0.35}
      />
      <g transform={`translate(19 ${H / 2 - 28})`} fill={ink}>
        <rect width={40} height={4} rx={1} fillOpacity={0.85} />
        <rect y={10} width={140} height={20} rx={2} />
        <rect y={37} width={84} height={6} rx={1} fillOpacity={0.9} />
        <rect y={51} width={56} height={4} rx={1} fillOpacity={0.85} />
      </g>
      <rect x={19} y={H - 23} width={30} height={4} rx={1} fill={ink} />
      <rect x={W - 49} y={H - 23} width={30} height={4} rx={1} fill={ink} />
    </svg>
  )
}

type Look = Pick<
  TenantSettings,
  | "report_cover_style"
  | "report_cover_horizon"
  | "report_cover_wave"
  | "report_cover_crest"
>

const lookOf = (s: TenantSettings): Look => ({
  report_cover_style: s.report_cover_style,
  report_cover_horizon: s.report_cover_horizon,
  report_cover_wave: s.report_cover_wave,
  report_cover_crest: s.report_cover_crest,
})

export function ReportCoverCard({ settings }: { settings: TenantSettings }) {
  const qc = useQueryClient()
  const [look, setLook] = useState<Look>(() => lookOf(settings))
  const [busy, setBusy] = useState<null | "upload" | "remove">(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => setLook(lookOf(settings)), [settings])

  const stored = (data: TenantSettings) => {
    qc.setQueryData(["tenant-settings"], data)
    qc.invalidateQueries({ queryKey: ["object-report-schema"] })
  }
  const save = useMutation({
    mutationFn: (patch: Look) =>
      api<TenantSettings>("/api/tenant-settings/", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      stored(data)
      toast.success("Saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  const upload = async (file: File) => {
    setBusy("upload")
    try {
      const body = new FormData()
      body.append("image", file)
      stored(await api<TenantSettings>(COVER_PATH, { method: "POST", body }))
      toast.success("Cover image uploaded")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    setBusy("remove")
    try {
      stored(await api<TenantSettings>(COVER_PATH, { method: "DELETE" }))
      toast.success("Cover image removed")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  const set = <TKey extends keyof Look>(k: TKey, v: Look[TKey]) =>
    setLook((l) => ({ ...l, [k]: v }))
  const hasImage = settings.report_cover_image_set
  const imageUrl = hasImage
    ? `${COVER_PATH}?v=${encodeURIComponent(settings.updated_at)}`
    : null
  const styles: { value: ReportCoverStyle; label: string }[] = [
    { value: "waves", label: "Waves" },
    { value: "plain", label: "Plain colour" },
    ...(hasImage ? [{ value: "upload" as const, label: "Your upload" }] : []),
    { value: "none", label: "None" },
  ]
  const dirty = (Object.keys(look) as (keyof Look)[]).some(
    (k) => look[k] !== settings[k]
  )
  const colours =
    look.report_cover_style === "waves" || look.report_cover_style === "plain"

  return (
    <SettingsCard
      title="Report cover"
      description="The cover page of this tenant's PDF reports."
      layout="plain"
      onSave={() => save.mutate(look)}
      dirty={dirty}
      saving={save.isPending}
      saveLabel="Save report cover"
    >
      <div className="flex flex-col gap-5 sm:flex-row" data-part="report-cover">
        <CoverPreview
          style={look.report_cover_style}
          horizon={look.report_cover_horizon}
          wave={look.report_cover_wave}
          crest={look.report_cover_crest}
          imageUrl={imageUrl}
        />
        <div className="grid min-w-0 flex-1 content-start gap-4">
          <Field label="Background">
            <SegmentedTabs<ReportCoverStyle>
              wrap
              items={styles}
              value={look.report_cover_style}
              onValueChange={(v) => set("report_cover_style", v)}
            />
          </Field>
          {colours && (
            <>
              <Field label="Presets">
                <div className="flex flex-wrap gap-1.5" data-part="presets">
                  {COVER_PRESETS.map((p) => (
                    <Tooltip key={p.key}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={p.label}
                          className="size-6 rounded-md border border-border"
                          style={{ background: p.horizon }}
                          onClick={() =>
                            setLook((l) => ({
                              ...l,
                              report_cover_horizon: p.horizon,
                              report_cover_wave: p.wave,
                              report_cover_crest: p.crest,
                            }))
                          }
                        />
                      </TooltipTrigger>
                      <TooltipContent variant="panel">{p.label}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormColor
                  label="Horizon"
                  info="The darkest tone of the waves, and the plain background's colour."
                  value={look.report_cover_horizon}
                  onChange={(v) => set("report_cover_horizon", v || "#063d66")}
                  allowEmpty={false}
                />
                <FormColor
                  label="Wave"
                  info="Moves the waves' mid tones."
                  value={look.report_cover_wave}
                  onChange={(v) => set("report_cover_wave", v || "#0b6fb0")}
                  allowEmpty={false}
                />
                <FormColor
                  label="Crest"
                  info="The light the crests catch."
                  value={look.report_cover_crest}
                  onChange={(v) => set("report_cover_crest", v || "#ffffff")}
                  allowEmpty={false}
                />
              </div>
            </>
          )}
          <Field
            label="Cover image"
            info="PNG, JPEG or SVG, at most 2 MB. Fills the page when the background is Your upload."
          >
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void upload(f)
                  e.target.value = ""
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => inputRef.current?.click()}
              >
                {busy === "upload" ? "Uploading…" : "Upload…"}
              </Button>
              {hasImage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  {busy === "remove" ? "Removing…" : "Remove"}
                </Button>
              )}
            </div>
          </Field>
        </div>
      </div>
    </SettingsCard>
  )
}
