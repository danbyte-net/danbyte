// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import type React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AutoCell,
  autoSortValue,
  autoText,
  collectRowKeys,
  coveredKeys,
  customFieldColumns,
  customSortValue,
  customValueText,
  getPath,
  listFieldColumns,
  mergeAutoColumns,
} from "./auto-columns"
import { buildDeviceColumns } from "./device-columns"
import { resolveColumnLabel } from "@/components/data-table"
import type { ListField } from "@/lib/list-fields"
import type { Device } from "@/lib/api"

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (slug: string) => slug !== "secret",
    humanIds: false,
  }),
}))

afterEach(cleanup)

const region: ListField = {
  key: "site.region",
  label: "Region",
  kind: "object",
  group: "related",
  related: "api.region",
  via: "Site",
}
const airflow: ListField = {
  key: "airflow",
  label: "Airflow",
  kind: "choice",
  group: "fields",
  options: [{ value: "front-to-rear", label: "Front to rear" }],
}
const position: ListField = {
  key: "position",
  label: "Position",
  kind: "number",
  group: "fields",
}
const template: ListField = {
  key: "config_template",
  path: "config_template.resolved",
  label: "Config template",
  kind: "object",
  group: "related",
  related: "api.exporttemplate",
}

describe("catalog columns", () => {
  it("are keyed by the field, hidden, grouped and exported by label", () => {
    const cols = listFieldColumns<Record<string, unknown>>([region, airflow])
    expect(cols.map((c) => c.id)).toEqual(["site.region", "airflow"])
    expect(cols[0].meta?.defaultHidden).toBe(true)
    expect(cols[0].meta?.group).toBe("related")
    expect(cols[0].meta?.export?.header).toBe("Region")
    expect(cols[0].enableGlobalFilter).toBe(false)
    const row = { site: { name: "HQ", region: { id: "r1", name: "Nordics" } } }
    expect(cols[0].meta?.export?.value(row)).toBe("Nordics")
    expect(cols[1].meta?.export?.value({ airflow: "front-to-rear" })).toBe(
      "Front to rear"
    )
  })

  it("read a field's path when it sits deeper than its key", () => {
    const [col] = listFieldColumns<Record<string, unknown>>([template])
    const row = { config_template: { own: null, resolved: { name: "edge" } } }
    expect(col.meta?.export?.value(row)).toBe("edge")
  })

  it("sort numbers by value, text naturally, and empty last", () => {
    expect(autoSortValue(position, 10)).toBe(10)
    expect(autoSortValue(position, "7")).toBe(7)
    expect(autoSortValue(region, { name: "DK 10" })).toBe("DK 10")
    expect(autoSortValue(region, null)).toBeUndefined()
    const [col] = listFieldColumns<Record<string, unknown>>([position])
    expect(col.sortUndefined).toBe("last")
  })

  it("turn values into export text by shape", () => {
    expect(autoText(region, [{ name: "a" }, { name: "b" }])).toBe("a, b")
    expect(autoText(position, true)).toBe("Yes")
    expect(autoText(position, "")).toBe("")
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1)
    expect(getPath({ a: null }, "a.b")).toBeUndefined()
  })

  it("render cells by kind", () => {
    const qc = new QueryClient()
    const wrap = (el: React.ReactNode) =>
      render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>)
    wrap(<AutoCell field={airflow} value="front-to-rear" />)
    expect(screen.getByText("Front to rear")).toBeTruthy()
    cleanup()
    wrap(<AutoCell field={region} value={{ id: "r1", name: "Nordics" }} />)
    expect(screen.getByText("Nordics").closest("a")?.getAttribute("href")).toBe(
      "/regions/r1"
    )
    cleanup()
    wrap(
      <AutoCell
        field={{ ...region, related: "api.secret" }}
        value={{ id: "s1", name: "Hidden" }}
      />
    )
    expect(screen.getByText("Hidden").closest("a")).toBeNull()
    cleanup()
    wrap(
      <AutoCell
        field={{ ...region, kind: "objects" }}
        value={[1, 2, 3, 4, 5].map((i) => ({ name: `n${i}` }))}
      />
    )
    expect(screen.getByText("+2")).toBeTruthy()
    cleanup()
    wrap(<AutoCell field={position} value={false} />)
    expect(screen.getByText("No")).toBeTruthy()
  })

  it("are offered only for keys the rows carry, remembered across empty pages", () => {
    const seen = new Set<string>()
    collectRowKeys([{ site: {}, name: "x" }], (r) => r, seen)
    collectRowKeys([], (r) => r, seen)
    expect([...seen].sort()).toEqual(["name", "site"])
  })
})

describe("custom-field columns", () => {
  const num = {
    key: "rank",
    label: "Rank",
    type: "decimal" as const,
    related_model: "",
  }
  const obj = {
    key: "owner",
    label: "Owner",
    type: "object" as const,
    related_model: "user",
  }
  const multi = {
    key: "tiers",
    label: "Tiers",
    type: "multiselect" as const,
    related_model: "",
  }

  it("are cf_<key>, sortable by value, and unsortable for references", () => {
    const cols = customFieldColumns<Record<string, unknown>>([num, obj], {
      defaultHidden: true,
    })
    expect(cols.map((c) => c.id)).toEqual(["cf_rank", "cf_owner"])
    expect(cols[0].enableSorting).toBe(true)
    expect(cols[1].enableSorting).toBe(false)
    expect(cols[0].meta?.group).toBe("custom")
    expect(customSortValue(num, "10.5")).toBe(10.5)
    expect(customSortValue(num, "")).toBeUndefined()
    expect(customSortValue(multi, ["b", "a"])).toBe("b, a")
  })

  it("export booleans, selections and known references as text", () => {
    const bool = { ...num, type: "boolean" as const }
    expect(customValueText(bool, false)).toBe("No")
    expect(customValueText(multi, ["gold", "silver"])).toBe("gold, silver")
    expect(customValueText(obj, "u1", () => "alice")).toBe("alice")
    expect(customValueText(obj, "u1")).toBe("u1")
  })
})

describe("merging into a factory's columns", () => {
  type R = Record<string, unknown>
  const own: ColumnDef<R, unknown>[] = [
    { id: "name", accessorKey: "name", header: "Name" },
    {
      id: "type",
      accessorKey: "x",
      header: "Type",
      meta: { field: "device_type" },
    },
    { id: "updated", header: "Updated" },
    { id: "actions", enableHiding: false },
  ]
  const extra = listFieldColumns<R>([
    { key: "name", label: "Name", kind: "text", group: "fields" },
    {
      key: "device_type",
      label: "Device type",
      kind: "object",
      group: "related",
    },
    { key: "updated_at", label: "Updated", kind: "datetime", group: "fields" },
    { key: "asset_tag", label: "Asset tag", kind: "text", group: "fields" },
    { key: "location", label: "Location", kind: "object", group: "related" },
  ])

  it("adds only what no factory column covers, before the row actions", () => {
    const merged = mergeAutoColumns(own, extra, ["location"])
    expect(merged.map((c) => c.id)).toEqual([
      "name",
      "type",
      "updated",
      "asset_tag",
      "actions",
    ])
    expect([...coveredKeys(own)]).toContain("updated_at")
  })

  it("leaves the device factory with no two columns of one label", () => {
    const catalog: ListField[] = [
      "name:Name:text",
      "device_type:Device type:object",
      "device_type.manufacturer:Manufacturer:text",
      "site:Site:object",
      "site.region:Region:object",
      "role:Role:object",
      "platform:Platform:object",
      "serial_number:Serial number:text",
      "asset_tag:Asset tag:text",
      "status:Status:object",
      "primary_ip:Primary IP:object",
      "secondary_ip:Secondary IP:object",
      "oob_ip:OOB IP:object",
      "ip_count:IP count:number",
      "description:Description:longtext",
      "tags:Tags:tags",
      "created_at:Created:datetime",
      "updated_at:Updated:datetime",
      "location:Location:object",
      "rack:Rack:object",
    ].map((s) => {
      const [key, label, kind] = s.split(":")
      return { key, label, kind, group: "fields" } as ListField
    })
    const base = buildDeviceColumns<Device>({ selection: true })
    const merged = mergeAutoColumns(base, listFieldColumns<Device>(catalog))
    const labels = merged
      .filter((c) => c.enableHiding !== false)
      .map((c) => resolveColumnLabel(c.id!, c))
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i)
    expect(dupes).toEqual([])
    expect(merged.map((c) => c.id)).toContain("site.region")
    expect(merged.map((c) => c.id)).not.toContain("device_type")
    expect(merged.map((c) => c.id)).not.toContain("serial_number")
  })
})
