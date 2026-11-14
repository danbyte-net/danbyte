// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  ApiError,
  apiErrorMessage,
  firstErrorText,
  itemErrors,
} from "@/lib/api"
import { useFieldErrors } from "@/components/forms/use-field-errors"

// DRF's nested-list errors: a dict keyed by the failing items' index from
// 0.20 (LIST_SERIALIZER_ERRORS_AS_DICT), a list with {} per valid item before.
const DICT = { "1": { timeout_minutes: ["Ensure this value is ≥ 1."] } }
const LIST = [{}, { timeout_minutes: ["Ensure this value is ≥ 1."] }, {}]

describe("itemErrors", () => {
  it("reads both shapes by position", () => {
    const fromDict = itemErrors(DICT)
    const fromList = itemErrors(LIST)
    expect(fromDict?.[1]).toEqual(DICT["1"])
    expect(fromList?.[1]).toEqual(LIST[1])
    expect(fromDict?.[0]).toEqual({})
  })

  it("fills the gaps of a sparse dict", () => {
    expect(itemErrors({ "2": { a: ["x"] } })).toEqual([{}, {}, { a: ["x"] }])
  })

  it("is null for a message list or a field dict", () => {
    expect(itemErrors(["This list may not be empty."])).toBeNull()
    expect(itemErrors({ name: ["Required."] })).toBeNull()
    expect(itemErrors(null)).toBeNull()
    expect(itemErrors({})).toBeNull()
  })
})

describe("firstErrorText", () => {
  it("names the row of a per-item error, in either shape", () => {
    const want = "row 2, timeout_minutes: Ensure this value is ≥ 1."
    expect(firstErrorText(DICT)).toBe(want)
    expect(firstErrorText(LIST)).toBe(want)
  })

  it("reads plain messages", () => {
    expect(firstErrorText(["Required."])).toBe("Required.")
    expect(firstErrorText("Bad.")).toBe("Bad.")
    expect(firstErrorText({ non_field_errors: ["Clash."] })).toBe("Clash.")
    expect(firstErrorText([])).toBeNull()
  })
})

describe("apiErrorMessage with nested list errors", () => {
  it("toasts the first item's message with its field and row", () => {
    const err = new ApiError(400, { steps: DICT }, "/api/x/ → 400")
    expect(apiErrorMessage(err)).toBe(
      "steps: row 2, timeout_minutes: Ensure this value is ≥ 1."
    )
  })
})

describe("useFieldErrors with nested list errors", () => {
  it("puts a readable message on the list field", () => {
    const { result } = renderHook(() => useFieldErrors())
    let msg: string | null = null
    act(() => {
      msg = result.current.handleApiError(
        new ApiError(400, { steps: DICT, name: ["Taken."] }, "/api/x/ → 400")
      )
    })
    expect(msg).toBe("Couldn't save - check the highlighted fields.")
    expect(result.current.fieldErrors.steps).toBe(
      "row 2, timeout_minutes: Ensure this value is ≥ 1."
    )
    expect(result.current.fieldErrors.name).toBe("Taken.")
  })
})
