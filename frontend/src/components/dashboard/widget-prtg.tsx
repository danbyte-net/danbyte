import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { ApiError, api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  Paginated,
  PrtgConnection,
  PrtgHistoryRange,
  PrtgSensor,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { DevicePicker } from "@/components/device-picker"
import { VMPicker } from "@/components/vm-picker"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TimeCell } from "@/components/cells/time-ago"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import {
  SensorLink,
  sensorSince,
} from "@/components/columns/prtg-sensor-columns"
import {
  ChannelReading,
  ChannelTrend,
  pickChannel,
  seriesFor,
  useChannels,
  useHistory,
} from "@/components/prtg/channel-view"
import { PrtgSensorState } from "@/components/prtg/sensors-tab"

// Dashboard widgets over PRTG: one sensor channel drawn as a gauge, lookup
// bar, value or sparkline, and the tenant's (or one connection's) alarms.
// Both store ids only and read live data with the viewer's permissions, so
// a shared dashboard shows each viewer what they may see.

/** What a Sensor widget remembers: ids and choices, never a reading. */
export interface SensorWidgetConfig {
  object?: "device" | "virtual_machine"
  device?: string | null
  virtual_machine?: string | null
  sensor?: string | null
  /** A channel id; empty is the sensor's primary channel. */
  channel?: string
  display?: SensorWidgetDisplay
  range?: PrtgHistoryRange
  /** Replaces the widget's title. */
  title?: string
}

export type SensorWidgetDisplay = "gauge" | "lookup" | "value" | "sparkline"

const DISPLAYS: { value: SensorWidgetDisplay; label: string }[] = [
  { value: "gauge", label: "Gauge" },
  { value: "lookup", label: "Lookup bar" },
  { value: "value", label: "Value" },
  { value: "sparkline", label: "Sparkline" },
]

const RANGES: { value: PrtgHistoryRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
]

const PRIMARY = "__primary__"

/** The widget's title: the override, else the catalog's. */
export function sensorWidgetTitle(
  config: Record<string, unknown> | undefined
): string | undefined {
  const t = (config as SensorWidgetConfig | undefined)?.title?.trim()
  return t || undefined
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-4 text-center text-xs text-muted-foreground">{children}</p>
  )
}

type Outcome = "ok" | "no-data" | "no-access"

/** A 403 is no access; a 404 is either a sensor that is gone (or an
 * integration that is off) or an object the viewer cannot see - the
 * object's own page tells the two apart. */
async function readSensor(
  id: string,
  parentPath: string | null
): Promise<{ outcome: Outcome; sensor?: PrtgSensor }> {
  try {
    return {
      outcome: "ok",
      sensor: await api<PrtgSensor>(`/api/prtg/sensors/${id}/`),
    }
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    if (e.status === 403) return { outcome: "no-access" }
    if (e.status !== 404) throw e
    if (!parentPath) return { outcome: "no-data" }
    try {
      await api(parentPath)
      return { outcome: "no-data" }
    } catch (p) {
      if (p instanceof ApiError && (p.status === 403 || p.status === 404))
        return { outcome: "no-access" }
      return { outcome: "no-data" }
    }
  }
}

function SensorSettings({
  config,
  setConfig,
}: {
  config: SensorWidgetConfig
  setConfig: (c: SensorWidgetConfig) => void
}) {
  const kind = config.object ?? "device"
  const parentId = kind === "device" ? config.device : config.virtual_machine
  const sensors = useQuery({
    queryKey: ["prtg-widget-sensor-options", kind, parentId],
    queryFn: async () =>
      (
        await apiAll<PrtgSensor>(
          `/api/prtg/sensors/?${kind}=${parentId}&ordering=name`
        )
      ).results,
    enabled: !!parentId,
    staleTime: 60_000,
  })
  const channels = useChannels(config.sensor ?? null)
  const save = (patch: Partial<SensorWidgetConfig>) =>
    setConfig({ ...config, ...patch })
  return (
    <div className="flex flex-col gap-2" data-testid="sensor-widget-settings">
      <SegmentedTabs
        value={kind}
        onValueChange={(v) =>
          save({
            object: v,
            device: null,
            virtual_machine: null,
            sensor: null,
            channel: "",
          })
        }
        items={[
          { value: "device", label: "Device" },
          { value: "virtual_machine", label: "VM" },
        ]}
      />
      {kind === "device" ? (
        <DevicePicker
          value={config.device ?? null}
          onChange={(v) => save({ device: v, sensor: null, channel: "" })}
        />
      ) : (
        <VMPicker
          value={config.virtual_machine ?? null}
          onChange={(v) =>
            save({ virtual_machine: v, sensor: null, channel: "" })
          }
        />
      )}
      <div className="flex gap-2">
        <Select
          value={config.sensor ?? ""}
          onValueChange={(v) => save({ sensor: v, channel: "" })}
          disabled={!parentId}
        >
          <SelectTrigger
            size="sm"
            aria-label="Sensor"
            className="min-w-0 flex-1"
          >
            <SelectValue placeholder="Sensor" />
          </SelectTrigger>
          <SelectContent>
            {(sensors.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={config.channel || PRIMARY}
          onValueChange={(v) => save({ channel: v === PRIMARY ? "" : v })}
          disabled={!config.sensor}
        >
          <SelectTrigger
            size="sm"
            aria-label="Channel"
            className="min-w-0 flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PRIMARY}>Primary</SelectItem>
            {(channels.data?.rows ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Select
          value={config.display ?? "gauge"}
          onValueChange={(v) => save({ display: v as SensorWidgetDisplay })}
        >
          <SelectTrigger
            size="sm"
            aria-label="Display"
            className="min-w-0 flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DISPLAYS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {config.display === "sparkline" && (
          <SegmentedTabs
            value={config.range ?? "1h"}
            onValueChange={(v) => save({ range: v })}
            items={RANGES}
          />
        )}
      </div>
      <Input
        aria-label="Title"
        placeholder="Title"
        className="h-8"
        maxLength={80}
        value={config.title ?? ""}
        onChange={(e) => save({ title: e.target.value })}
      />
    </div>
  )
}

/**
 * The Sensor widget: one channel of one sensor, drawn as the chosen display,
 * with the sensor's state pill and a link to its object's Sensors tab.
 * "No data" when the sensor is gone or the integration is off; "No access"
 * when the viewer may not see it.
 */
export function SensorWidget({
  config,
  editing,
  setConfig,
}: {
  config?: SensorWidgetConfig
  editing?: boolean
  setConfig?: (c: SensorWidgetConfig) => void
}) {
  const cfg = config ?? {}
  const parentPath = cfg.device
    ? `/api/devices/${cfg.device}/`
    : cfg.virtual_machine
      ? `/api/virtual-machines/${cfg.virtual_machine}/`
      : null
  const sensor = useQuery({
    queryKey: ["prtg-widget-sensor", cfg.sensor, parentPath],
    queryFn: () => readSensor(cfg.sensor!, parentPath),
    enabled: !!cfg.sensor,
    staleTime: 60_000,
    retry: false,
  })
  const ok = sensor.data?.outcome === "ok"
  const channels = useChannels(ok ? cfg.sensor! : null)
  const display = cfg.display ?? "gauge"
  const range = cfg.range ?? "1h"
  const history = useHistory(
    ok && display === "sparkline" ? cfg.sensor! : null,
    display === "sparkline" ? range : null
  )
  const channel = pickChannel(channels.data?.rows, cfg.channel)

  let body: React.ReactNode
  if (!cfg.sensor) body = <Muted>No sensor chosen.</Muted>
  else if (sensor.isLoading || channels.isLoading) body = <Loading />
  else if (sensor.isError) body = <QueryError error={sensor.error} />
  else if (sensor.data?.outcome === "no-access") body = <Muted>No access</Muted>
  else if (!ok || channels.isError || !channel) body = <Muted>No data</Muted>
  else if (display === "sparkline")
    body = history.isLoading ? (
      <Loading />
    ) : (
      <div className="flex flex-col items-center gap-1">
        <ChannelReading channel={channel} display="value" />
        <ChannelTrend
          channel={channel}
          series={seriesFor(history.data, channel.id)}
          range={range}
          width={220}
          className="w-full"
        />
      </div>
    )
  else body = <ChannelReading channel={channel} display={display} />

  const s = sensor.data?.sensor
  return (
    <div className="flex h-full flex-col gap-2" data-testid="sensor-widget">
      {editing && setConfig && (
        <SensorSettings config={cfg} setConfig={setConfig} />
      )}
      {ok && s && (
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <SensorLink sensor={s}>
            <span className="truncate">
              {channel && channel.name !== s.name
                ? `${s.name} · ${channel.name}`
                : s.name}
            </span>
          </SensorLink>
          <span className="ml-auto shrink-0">
            <PrtgSensorState sensor={s} />
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {body}
      </div>
    </div>
  )
}

/** What a Sensor alarms widget remembers. */
export interface SensorAlarmsConfig {
  /** One connection's alarms; absent is every connection of the tenant. */
  connection?: string | null
  /** Rows shown before the link to the rest. */
  limit?: number
}

const ALL = "__all__"
const LIMITS = [5, 10, 20]

const ALARM_COLUMNS: SimpleColumn<PrtgSensor>[] = [
  {
    id: "sensor",
    header: "Sensor",
    flex: true,
    cell: (r) => (
      <span className="block min-w-0 truncate">
        <SensorLink sensor={r}>{r.name}</SensorLink>
      </span>
    ),
  },
  {
    id: "on",
    header: "On",
    cell: (r) => (
      <span className="text-xs text-muted-foreground">
        {r.device?.name ?? r.virtual_machine?.name ?? "-"}
      </span>
    ),
  },
  {
    id: "state",
    header: "Status",
    cell: (r) => <CheckStatusBadge status={r.state || "unknown"} />,
  },
  {
    id: "since",
    header: "Since",
    cell: (r) => {
      const at = sensorSince(r)
      return at ? <TimeCell iso={at} /> : "-"
    },
  },
]

/** PRTG's down and degraded sensors, worst and newest first, capped to a
 * few rows with a link to the full Alarms tab. */
export function SensorAlarmsWidget({
  config,
  editing,
  setConfig,
}: {
  config?: SensorAlarmsConfig
  editing?: boolean
  setConfig?: (c: SensorAlarmsConfig) => void
}) {
  const limit = config?.limit ?? 10
  const conn = config?.connection ?? null
  const q = useQuery({
    queryKey: ["prtg-widget-alarms", conn, limit],
    queryFn: async () => {
      try {
        return await api<Paginated<PrtgSensor>>(
          `/api/prtg/sensors/?alarms=1&ordering=alarms&page_size=${limit}${
            conn ? `&connection=${conn}` : ""
          }`
        )
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403))
          return null
        throw e
      }
    },
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  })
  const conns = useQuery({
    queryKey: ["prtg-widget-connections"],
    queryFn: async () =>
      (await apiAll<PrtgConnection>("/api/prtg/connections/")).results,
    enabled: !!editing,
    staleTime: 5 * 60_000,
  })
  return (
    <div
      className="flex h-full flex-col gap-2"
      data-testid="sensor-alarms-widget"
    >
      {editing && setConfig && (
        <div className="flex gap-2">
          <Select
            value={conn ?? ALL}
            onValueChange={(v) =>
              setConfig({ ...config, connection: v === ALL ? null : v })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label="Connection"
              className="min-w-0 flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every connection</SelectItem>
              {(conns.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(limit)}
            onValueChange={(v) => setConfig({ ...config, limit: Number(v) })}
          >
            <SelectTrigger size="sm" aria-label="Rows" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMITS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <QueryError error={q.error} />
      ) : q.data == null ? (
        <Muted>No data</Muted>
      ) : q.data.results.length === 0 ? (
        <Muted>No alarms.</Muted>
      ) : (
        <>
          <SimpleTable
            columns={ALARM_COLUMNS}
            data={q.data.results.slice(0, limit)}
            getRowKey={(r) => r.id}
          />
          <Link
            to="/prtg"
            search={{ tab: "alarms" }}
            className="link self-end text-xs"
          >
            {q.data.count > limit
              ? `All ${q.data.count} alarms`
              : "Open alarms"}
          </Link>
        </>
      )}
    </div>
  )
}
