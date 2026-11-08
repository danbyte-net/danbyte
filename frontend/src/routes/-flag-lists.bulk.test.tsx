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

import { Route as WebhooksRoute } from "./webhooks.index"
import { Route as TargetsRoute } from "./automation-targets.index"
import { Route as ScriptsRoute } from "./scripts.index"
import { Route as PermissionsRoute } from "./permissions.index"
import { Route as UsersRoute } from "./users.index"
import {
  bodyOf,
  deleteAnswer,
  mountRoute,
  stubDom,
  tickAll,
} from "./-bulk-list-test-utils"

// The lists with an on/off switch - webhooks, automation targets, scripts
// and permissions (Enable / Disable), users (Activate / Deactivate): the
// buttons write that one field through `bulk-update/`; Delete previews
// first. Users have no bulk edit dialog, and only webhooks, targets and
// scripts export. Without change or delete, no selection.

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
vi.mock("@/components/automation-explainer", () => ({
  AutomationExplainer: () => null,
}))
vi.mock("@/components/site-role-dialog", () => ({
  SiteRoleDialog: () => null,
}))

stubDom()

const STAMP = {
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}
const ROW = {
  webhook: (id: string, name: string) => ({
    ...STAMP,
    id,
    name,
    enabled: true,
    object_types: ["device"],
    on_create: true,
    on_update: true,
    on_delete: false,
    payload_url: "https://hooks.example/x",
    http_method: "POST",
    http_content_type: "application/json",
    secret_set: true,
    additional_headers_set: false,
    additional_header_names: [],
    ssl_verification: true,
  }),
  target: (id: string, name: string) => ({
    ...STAMP,
    id,
    name,
    kind: "awx",
    kind_display: "AWX",
    enabled: true,
    base_url: "https://awx.example",
    job_template_id: "",
    token_set: true,
    ssl_verify: true,
    extra_vars: {},
    auto_on_change: false,
    object_types: [],
  }),
  script: (id: string, name: string) => ({
    ...STAMP,
    id,
    name,
    slug: name.toLowerCase(),
    description: "",
    language: "python",
    source: "",
    params_schema: [],
    token_scope: "full",
    timeout_seconds: 60,
    trusted: false,
    run_as: "caller",
    owner: null,
    owner_name: "me",
    visibility: "owner",
    shared_users: [],
    shared_groups: [],
    schedule_enabled: false,
    cadence: {},
    cadence_label: "",
    next_run_at: null,
    retention: {},
    schedule_params: {},
    last_run_at: null,
    last_run_time: null,
    last_run_status: null,
    run_count: 0,
    enabled: true,
  }),
  permission: (id: string, name: string) => ({
    ...STAMP,
    id,
    name,
    description: "",
    enabled: true,
    object_types: ["rack"],
    actions: ["view"],
    constraints: null,
    tenants: [],
    sites: [],
    groups: [],
    users: [],
  }),
  user: (id: string, name: string) => ({
    id: Number(id.slice(1)),
    username: name,
    email: "",
    first_name: "",
    last_name: "",
    is_active: true,
    is_superuser: false,
    is_staff: false,
    last_login: null,
    date_joined: "2026-01-01T00:00:00Z",
    groups: [],
    tenants: [],
    auth_source: "local",
    require_mfa: false,
    mfa_active: false,
  }),
}

const CASES = [
  {
    title: "Webhooks",
    path: "/webhooks",
    endpoint: "/api/webhooks/",
    component: WebhooksRoute.options.component,
    row: ROW.webhook,
    field: "enabled",
    on: "Enable",
    off: "Disable",
    ids: ["r1", "r2"],
    exports: true,
    edits: true,
  },
  {
    title: "Automation targets",
    path: "/automation-targets",
    endpoint: "/api/automation-targets/",
    component: TargetsRoute.options.component,
    row: ROW.target,
    field: "enabled",
    on: "Enable",
    off: "Disable",
    ids: ["r1", "r2"],
    exports: true,
    edits: true,
  },
  {
    title: "Scripts",
    path: "/scripts",
    endpoint: "/api/scripts/",
    component: ScriptsRoute.options.component,
    row: ROW.script,
    field: "enabled",
    on: "Enable",
    off: "Disable",
    ids: ["r1", "r2"],
    exports: true,
    edits: true,
  },
  {
    title: "Permissions",
    path: "/permissions",
    endpoint: "/api/object-permissions/",
    component: PermissionsRoute.options.component,
    row: ROW.permission,
    field: "enabled",
    on: "Enable",
    off: "Disable",
    ids: ["r1", "r2"],
    exports: false,
    edits: true,
  },
  {
    title: "Users",
    path: "/users",
    endpoint: "/api/users/",
    component: UsersRoute.options.component,
    row: ROW.user,
    field: "is_active",
    on: "Activate",
    off: "Deactivate",
    ids: ["1", "2"],
    exports: false,
    edits: false,
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
      if (path.endsWith("bulk-update/")) return Promise.resolve({ updated: 2 })
      if (path.endsWith("bulk-delete/"))
        return Promise.resolve(
          deleteAnswer(
            [c.ids[1]],
            [{ id: c.ids[0], name: "Alpha", reason: "Kept." }]
          )
        )
      if (path.startsWith(c.endpoint))
        return Promise.resolve({
          count: 2,
          next: null,
          results: [c.row("r1", "Alpha"), c.row("r2", "Bravo")],
        })
      return Promise.resolve({ count: 0, results: [], next: null })
    })
  })

  it("switches the ticked rows off through the bulk update", async () => {
    mountRoute(c.path, c.component)
    const bar = await tickAll("Bravo")
    expect(bar.getByRole("button", { name: c.on })).toBeTruthy()
    fireEvent.click(bar.getByRole("button", { name: c.off }))
    await waitFor(() =>
      expect(bodyOf(apiMock.mock.calls, `${c.endpoint}bulk-update/`)).toEqual({
        ids: c.ids,
        fields: { [c.field]: false },
      })
    )
  })

  it("offers Export and Edit only where the type has them", async () => {
    mountRoute(c.path, c.component)
    const bar = await tickAll("Bravo")
    expect(!!bar.queryByRole("button", { name: /Export/ })).toBe(c.exports)
    expect(!!bar.queryByRole("button", { name: /^Edit$/ })).toBe(c.edits)
  })

  it("previews a bulk delete and names the row kept", async () => {
    mountRoute(c.path, c.component)
    const bar = await tickAll("Bravo")
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Kept.")).toBeTruthy()
    expect(bodyOf(apiMock.mock.calls, `${c.endpoint}bulk-delete/`)).toEqual({
      ids: c.ids,
      dry_run: true,
    })
  })

  it("offers no selection without change or delete", async () => {
    can.value = false
    mountRoute(c.path, c.component)
    await screen.findByText("Bravo")
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull()
  })
})
