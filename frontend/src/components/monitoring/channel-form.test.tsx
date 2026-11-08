// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { NotificationChannel } from "@/lib/api"
import { ChannelForm } from "./channel-form"

// The webhook URL and the PagerDuty routing key are write-only: the form
// never prefills them, says when one is stored, and only sends a typed value.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => () => {},
  useRouterState: (opts: {
    select: (s: { location: { search: object } }) => unknown
  }) => opts.select({ location: { search: {} } }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const channel = (over: Partial<NotificationChannel>): NotificationChannel => ({
  id: "c1",
  name: "Ops",
  kind: "slack",
  config: {},
  on_statuses: [],
  min_severity: "warning",
  enabled: true,
  self_subscribable: false,
  send_status_changes: false,
  status_change_mode: "batched",
  status_change_interval_minutes: 30,
  status_change_last_run: null,
  match_prefix: null,
  match_ip: null,
  match_device: null,
  bot_token_set: false,
  url_set: false,
  routing_key_set: false,
  auto_created: false,
  created_at: "",
  updated_at: "",
  ...over,
})

const renderForm = (ch?: NotificationChannel) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChannelForm channel={ch} onSaved={() => {}} onCancel={() => {}} />
    </QueryClientProvider>
  )

const sentBody = () => {
  const call = apiMock.mock.calls.find(([, init]) => init?.method)
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({ id: "c1" })
})
afterEach(cleanup)

describe("ChannelForm credentials", () => {
  it("shows a stored webhook URL as stored and keeps it on save", async () => {
    renderForm(channel({ kind: "slack", url_set: true }))
    const input = screen.getByPlaceholderText("Stored - type to replace")
    expect(input).toHaveProperty("value", "")
    expect(input).toHaveProperty("type", "password")
    expect(input).toHaveProperty("required", false)
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(sentBody().config).toEqual({})
  })

  it("sends a typed replacement", async () => {
    renderForm(channel({ kind: "slack", url_set: true }))
    fireEvent.change(screen.getByPlaceholderText("Stored - type to replace"), {
      target: { value: "https://hooks.example.com/new" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(sentBody().config).toEqual({ url: "https://hooks.example.com/new" })
  })

  it("never prefills a PagerDuty routing key", () => {
    renderForm(channel({ kind: "pagerduty", routing_key_set: true }))
    const input = screen.getByPlaceholderText("Stored - type to replace")
    expect(input).toHaveProperty("value", "")
    expect(input).toHaveProperty("type", "password")
  })
})
