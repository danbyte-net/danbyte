// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { HolidayCalendar } from "@/lib/api"
import { HolidayCalendarEditor } from "./holiday-calendar-editor"

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
  }),
}))
vi.mock("sonner", () => ({ toast: toastMock }))
// The form footer asks the router whether a planned change is being made.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouterState: ({
    select,
  }: {
    select: (s: { location: { search: object } }) => unknown
  }) => select({ location: { search: {} } }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

// The editor opens on this year, in the default timezone.
const Y = new Date().getFullYear()

const CALENDAR: HolidayCalendar = {
  id: "c1",
  name: "Denmark",
  description: "",
  dates: [{ date: "2020-12-25", name: "Christmas Day", yearly: true }],
  agreement_count: 0,
}

function open(props: Partial<Parameters<typeof HolidayCalendarEditor>[0]>) {
  const onClose = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <HolidayCalendarEditor onClose={onClose} {...props} />
    </QueryClientProvider>
  )
  return { onClose }
}

const day = (label: RegExp) => screen.getByRole("button", { name: label })
const patchBody = () => {
  const call = apiMock.mock.calls.find(([, init]) => init?.method === "PATCH")
  return call && JSON.parse(String(call[1]?.body))
}

async function pasteDates(text: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: /Import/ }), {
    key: "Enter",
  })
  fireEvent.click(await screen.findByRole("menuitem", { name: /Paste dates/ }))
  fireEvent.change(await screen.findByPlaceholderText(/Christmas Eve/), {
    target: { value: text },
  })
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockResolvedValue({})
  Object.values(toastMock).forEach((f) => f.mockReset())
})
afterEach(cleanup)
// A year is 365 buttons, each in a tooltip: jsdom takes its time.
vi.setConfig({ testTimeout: 30_000 })

describe("HolidayCalendarEditor", () => {
  it("saves toggled, named days as {date, name, yearly}", async () => {
    const { onClose } = open({ calendar: CALENDAR })
    fireEvent.click(day(new RegExp(`^\\w+ 15 March ${Y}$`)))
    fireEvent.change(screen.getByLabelText("Name for 15 March"), {
      target: { value: "  Spring day  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(apiMock.mock.calls[0][0]).toBe(
      "/api/monitoring/holiday-calendars/c1/"
    )
    expect(patchBody()).toEqual({
      name: "Denmark",
      dates: [
        { date: "2020-12-25", name: "Christmas Day", yearly: true },
        { date: `${Y}-03-15`, name: "Spring day", yearly: false },
      ],
    })
  })

  it("marks an every-year day, and undoes a click that takes it off", () => {
    open({ calendar: CALENDAR })
    const xmas = day(new RegExp(`25 December ${Y}, Christmas Day, every year`))
    expect(xmas.className).toContain("ring-inset")
    fireEvent.click(xmas)
    expect(screen.queryByLabelText("Name for 25 December")).toBeNull()
    expect(screen.getByText("Removed Christmas Day")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.getByLabelText("Name for 25 December")).toBeTruthy()
  })

  it("imports pasted days, ranges included, and Undo takes them back", async () => {
    open({ calendar: CALENDAR })
    await pasteDates(`${Y}-12-26 – ${Y}-12-27 Boxing`)
    fireEvent.click(screen.getByRole("button", { name: "Add 2 days" }))
    expect(screen.getByText("Added 2 days")).toBeTruthy()
    expect(screen.getByLabelText("Name for 27 December")).toHaveProperty(
      "value",
      "Boxing"
    )
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.queryByLabelText("Name for 27 December")).toBeNull()
  })

  it("refuses an import past the day limit", async () => {
    open({ calendar: CALENDAR })
    const years = [Y - 2, Y - 1, Y].map((y) => `${y}-01-01 - ${y}-12-31`)
    await pasteDates(years.join("\n"))
    fireEvent.click(screen.getByRole("button", { name: /^Add [\d,]+ days$/ }))
    expect(toastMock.error).toHaveBeenCalledWith(
      "A calendar holds at most 1,000 days."
    )
    expect(screen.queryByText(/^Added/)).toBeNull()
  })

  it("counts dates typed but not added as unsaved", async () => {
    const { onClose } = open({ calendar: CALENDAR })
    await pasteDates(`${Y}-05-01`)
    // The paste panel's Cancel comes first, the dialog footer's last.
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0])
    // The paste panel's own Cancel closes only the panel; the footer's asks.
    expect(screen.queryByPlaceholderText(/Christmas Eve/)).toBeNull()
    await pasteDates(`${Y}-05-01`)
    const buttons = screen.getAllByRole("button", { name: "Cancel" })
    fireEvent.click(buttons[buttons.length - 1])
    expect(await screen.findByText("Discard unsaved changes?")).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("moves the focus to the next row after a remove", () => {
    open({
      calendar: {
        ...CALENDAR,
        dates: [
          { date: `${Y}-12-24`, name: "", yearly: false },
          { date: `${Y}-12-26`, name: "", yearly: false },
        ],
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Remove 24 December" }))
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove 26 December" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove 26 December" }))
    expect(document.activeElement?.getAttribute("data-day")).toBeTruthy()
  })

  it("shows a calendar read-only", () => {
    const { onClose } = open({ calendar: CALENDAR, readOnly: true })
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull()
    expect(screen.queryByLabelText("Name for 25 December")).toBeNull()
    fireEvent.click(day(new RegExp(`^\\w+ 15 March ${Y}$`)))
    expect(day(new RegExp(`15 March ${Y}`)).getAttribute("aria-pressed")).toBe(
      "false"
    )
    const close = screen
      .getAllByRole("button", { name: "Close" })
      .find((b) => b.textContent === "Close")
    fireEvent.click(close!)
    expect(onClose).toHaveBeenCalled()
    expect(apiMock).not.toHaveBeenCalled()
  })
})
