// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { Route as ContextsRoute } from "./config-contexts.index"
import { Route as BundlesRoute } from "./config-bundles.index"
import { Route as ExportTemplatesRoute } from "./export-templates.index"
import { Route as LabelTemplatesRoute } from "./label-templates.index"
import {
  bodyOf,
  deleteAnswer,
  mountRoute,
  stubDom,
  tickAll,
} from "./-bulk-list-test-utils"

// The configuration lists - contexts, bundles, export and label templates:
// ticked rows offer Export, Edit (the server's fields) and Delete (a dry run
// first, naming what is kept). Without change or delete, no selection.

const { apiMock, can } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  can: { value: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({ apiAll: (p: string) => apiMock(p) }))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: (_t: string, a: string) => a === "view" || can.value,
    humanIds: false,
  }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", async () => ({
  ListPageShell: (await import("./-bulk-list-test-utils")).ShellStub,
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))
vi.mock("@/components/label-template-form", () => ({
  LabelTemplateFormDialog: () => null,
}))

stubDom()

const BASE = {
  numid: null,
  description: "",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}
const ROW = {
  context: (id: string, name: string) => ({
    ...BASE,
    id,
    name,
    weight: 1000,
    is_active: true,
    data: { ntp: [] },
    regions: [],
    sites: [],
    device_roles: [],
    platforms: [],
  }),
  bundle: (id: string, name: string) => ({
    ...BASE,
    id,
    name,
    templates: [],
    roles: [],
  }),
  export: (id: string, name: string) => ({
    ...BASE,
    id,
    name,
    object_type: "device",
    object_type_label: "Device",
    template_code: "",
    mime_type: "text/plain",
    file_extension: "txt",
    as_attachment: true,
    target_path: "",
    bundle_path: "",
    is_directory: false,
  }),
  label: (id: string, name: string) => ({
    ...BASE,
    id,
    name,
    object_type: "device",
    object_type_label: "Device",
    width_mm: 62,
    height_mm: 29,
    margin_mm: 2,
    template_html: "",
    css: "",
    qr_enabled: true,
    qr_content: "",
    qr_size_mm: 18,
    is_default: false,
    device_type_ids: [],
    role_ids: [],
    device_types_detail: [],
    roles_detail: [],
  }),
}

const CASES = [
  {
    title: "Config contexts",
    path: "/config-contexts",
    endpoint: "/api/config-contexts/",
    component: ContextsRoute.options.component,
    row: ROW.context,
    edit: "Edit 2 contexts",
  },
  {
    title: "Config bundles",
    path: "/config-bundles",
    endpoint: "/api/config-bundles/",
    component: BundlesRoute.options.component,
    row: ROW.bundle,
    edit: "Edit 2 bundles",
  },
  {
    title: "Export templates",
    path: "/export-templates",
    endpoint: "/api/export-templates/",
    component: ExportTemplatesRoute.options.component,
    row: ROW.export,
    edit: "Edit 2 templates",
  },
  {
    title: "Label templates",
    path: "/label-templates",
    endpoint: "/api/label-templates/",
    component: LabelTemplatesRoute.options.component,
    row: ROW.label,
    edit: "Edit 2 templates",
  },
]

beforeAll(async () => {
  for (const c of CASES) {
    const lazy = c.component as { preload?: () => Promise<void> }
    await lazy.preload?.()
  }
})
afterEach(cleanup)

describe.each(CASES)("the $title list", (c) => {
  beforeEach(() => {
    can.value = true
    apiMock.mockReset()
    apiMock.mockImplementation((path) => {
      if (path.endsWith("bulk-delete/"))
        return Promise.resolve(
          deleteAnswer(["r2"], [{ id: "r1", name: "Alpha", reason: "Kept." }])
        )
      if (path.endsWith("bulk-edit-fields/"))
        return Promise.resolve({
          tags: false,
          custom_fields: null,
          fields: [{ key: "description", label: "Description", kind: "text" }],
        })
      if (path.startsWith(c.endpoint))
        return Promise.resolve({
          count: 2,
          next: null,
          results: [c.row("r1", "Alpha"), c.row("r2", "Bravo")],
        })
      return Promise.resolve({ count: 0, results: [], next: null })
    })
  })

  it("previews a bulk delete and names the row kept", async () => {
    mountRoute(c.path, c.component)
    const bar = await tickAll("Bravo")
    expect(bar.getByRole("button", { name: /Export/ })).toBeTruthy()
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Kept.")).toBeTruthy()
    expect(bodyOf(apiMock.mock.calls, `${c.endpoint}bulk-delete/`)).toEqual({
      ids: ["r1", "r2"],
      dry_run: true,
    })
  })

  it("opens the bulk edit with the server's fields", async () => {
    mountRoute(c.path, c.component)
    const bar = await tickAll("Bravo")
    fireEvent.click(bar.getByRole("button", { name: /Edit/ }))
    expect(await screen.findByText(c.edit)).toBeTruthy()
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) => p === `${c.endpoint}bulk-edit-fields/`)
      ).toBe(true)
    )
  })

  it("offers no selection without change or delete", async () => {
    can.value = false
    mountRoute(c.path, c.component)
    await screen.findByText("Bravo")
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull()
  })
})
