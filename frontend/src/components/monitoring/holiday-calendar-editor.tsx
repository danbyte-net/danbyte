import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import type { ChangeEvent, RefObject } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  FileUp,
  Upload,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DateFormat, HolidayCalendar, HolidayDay } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { readAllDayEvents } from "@/lib/ics"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InfoTip } from "@/components/ui/info-tip"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Textarea } from "@/components/ui/textarea"
import { Field, FormFooter, useFieldErrors } from "@/components/forms"
import { LeaveGuardDialog } from "@/components/leave-guard-dialog"
import {
  MAX_DAYS,
  MAX_YEAR,
  MIN_YEAR,
  NAME_MAX,
  dayKey,
  dayLabel,
  dayMonth,
  daysFromIcs,
  daysInYear,
  isWeekend,
  mergeDays,
  normaliseDays,
  parsePasted,
  pasteFormats,
  removeDay,
  renameDay,
  sameDayIn,
  setYearly,
  toggleDay,
} from "./holiday-days"
import { HolidayYear } from "./holiday-year"

const URL = "/api/monitoring/holiday-calendars/"
/** Holiday feeds are a few kilobytes; anything this big is not one. */
const ICS_MAX_BYTES = 2 * 1024 * 1024

const plural = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`

/** What the last import did, with the days from before it for Undo. The
 * strip lives in the editor, not a toast: a modal dialog makes the page
 * behind it, toasts included, unclickable. */
interface Notice {
  title: string
  detail: string
  before: HolidayDay[]
}

/**
 * Create or edit a holiday calendar on a year view: click days to add or
 * remove them, name them in the list beside it, mark fixed-date ones as every
 * year, or import pasted dates and .ics files. Opened from the calendar list.
 */
export function HolidayCalendarEditor({
  calendar,
  readOnly = false,
  onClose,
}: {
  calendar?: HolidayCalendar
  readOnly?: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { today, settings } = useDateFormat()
  const thisYear = Number(today.slice(0, 4))
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const nameId = useId()

  const [initial] = useState(() => normaliseDays(calendar?.dates ?? []))
  const [name, setName] = useState(calendar?.name ?? "")
  const [days, setDays] = useState(initial)
  const [year, setYear] = useState(thisYear)
  const [focusIso, setFocusIso] = useState(today)
  const [pasting, setPasting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [askDiscard, setAskDiscard] = useState(false)
  /** A day just added by a click, to scroll its row into view. */
  const [reveal, setReveal] = useState<string | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Paste was picked from the menu: focus goes to its box, not back to the
   * menu's button (Enter typed there would open the menu again). */
  const toPaste = useRef(false)
  const pasteBox = useRef<HTMLTextAreaElement>(null)

  const dirty =
    name.trim() !== (calendar?.name ?? "") ||
    JSON.stringify(days) !== JSON.stringify(initial)

  const requestClose = () => {
    if (dirty && !readOnly) setAskDiscard(true)
    else onClose()
  }

  /** Any hand edit: the import strip's Undo would now throw it away. */
  const edit = useCallback((fn: (d: HolidayDay[]) => HolidayDay[]) => {
    setDays(fn)
    setNotice(null)
  }, [])

  const onToggle = useCallback(
    (iso: string) => {
      edit((d) => toggleDay(d, iso))
      setReveal(iso)
    },
    [edit]
  )

  const onFocusDay = useCallback((iso: string) => {
    setFocusIso(iso)
    setYear(Number(iso.slice(0, 4)))
  }, [])

  const changeYear = (y: number) => {
    const next = Math.min(MAX_YEAR, Math.max(MIN_YEAR, y))
    setYear(next)
    // Keep a tab stop in the grid: the same day in the new year.
    setFocusIso((f) => sameDayIn(f, next))
  }

  const shown = useMemo(() => daysInYear(days, year), [days, year])

  // A click that adds a day brings its row into view in the list - only the
  // list scrolls, so the calendar stays where it is.
  useEffect(() => {
    if (!reveal) return
    setReveal(null)
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-row="${reveal}"]`)
    if (!list || !row || list.scrollHeight <= list.clientHeight) return
    const r = row.getBoundingClientRect()
    const l = list.getBoundingClientRect()
    if (r.top < l.top) list.scrollTop -= l.top - r.top
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom
  }, [reveal])

  /** Add imported days, or say why not. */
  const importDays = (incoming: HolidayDay[], skipped: string[]): boolean => {
    const merged = mergeDays(days, incoming)
    if (merged.days.length > MAX_DAYS) {
      toast.error(
        `A calendar holds at most ${MAX_DAYS.toLocaleString("en-US")} days.`
      )
      return false
    }
    if (merged.added === 0 && merged.named === 0) {
      toast.info("Nothing new to add", {
        description: skipped.join(" · ") || undefined,
      })
      return true
    }
    const { years } = merged
    const span =
      years.length === 0
        ? ""
        : years.length === 1
          ? String(years[0])
          : `${years[0]}–${years[years.length - 1]}`
    const parts = [
      merged.yearly ? `${merged.yearly} every year` : "",
      span,
      merged.named && merged.added
        ? `${plural(merged.named, "day")} named`
        : "",
      ...skipped,
    ].filter(Boolean)
    setNotice({
      title: merged.added
        ? `Added ${plural(merged.added, "day")}`
        : `Named ${plural(merged.named, "day")}`,
      detail: parts.join(" · "),
      before: days,
    })
    setDays(merged.days)
    // Show where the days went when none landed in the year in view.
    if (!merged.yearly && years.length && !years.includes(year))
      changeYear(years[0])
    return true
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    if (file.size > ICS_MAX_BYTES) {
      toast.error("That file is too large for a calendar")
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      toast.error("Couldn't read that file")
      return
    }
    const read = readAllDayEvents(text)
    const skipped = [
      read.timed ? `${plural(read.timed, "timed event")} skipped` : "",
      read.repeating
        ? `${plural(read.repeating, "repeating event")} skipped`
        : "",
      read.other ? `${plural(read.other, "other event")} skipped` : "",
    ].filter(Boolean)
    if (read.events.length === 0) {
      toast.error("No all-day events in that file", {
        description: skipped.join(" · ") || undefined,
      })
      return
    }
    importDays(daysFromIcs(read.events), skipped)
  }

  const save = useMutation({
    mutationFn: () => {
      reset()
      const body = JSON.stringify({
        name: name.trim(),
        dates: days.map((d) => ({ ...d, name: d.name.trim() })),
      })
      return calendar
        ? api(`${URL}${calendar.id}/`, { method: "PATCH", body })
        : api(URL, { method: "POST", body })
    },
    onSuccess: () => {
      toast.success(calendar ? "Calendar saved" : "Calendar created")
      qc.invalidateQueries({ queryKey: ["holiday-calendars"] })
      onClose()
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })

  const title = readOnly
    ? (calendar?.name ?? "Holiday calendar")
    : calendar
      ? "Edit holiday calendar"
      : "New holiday calendar"

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        size="6xl"
        aria-describedby={undefined}
        // A new calendar starts at its name; an existing one opens on the
        // year, with nothing selected for a stray key to overwrite.
        onOpenAutoFocus={(e) => {
          if (!calendar) return
          const content = e.currentTarget as HTMLElement | null
          e.preventDefault()
          content?.focus()
        }}
        // The body scrolls, not the dialog: Save stays in view on a short
        // screen (see DialogContent on managing your own scroll region).
        className="flex flex-col overflow-hidden"
      >
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            if (!readOnly) save.mutate()
          }}
        >
          <DialogHeader className="shrink-0 gap-1 pr-10">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <DialogTitle className="whitespace-nowrap">{title}</DialogTitle>
              {!readOnly && (
                <div className="flex items-center gap-2">
                  <Label htmlFor={nameId} className="text-xs whitespace-nowrap">
                    Name
                    <span aria-hidden className="font-semibold text-primary">
                      *
                    </span>
                  </Label>
                  <Input
                    id={nameId}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoFocus={!calendar}
                    maxLength={100}
                    placeholder="Denmark"
                    aria-invalid={fieldErrors.name ? true : undefined}
                    className="h-8 w-56"
                  />
                </div>
              )}
              {!readOnly && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                    >
                      <Upload className="h-3.5 w-3.5" /> Import
                      <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-auto whitespace-nowrap"
                    onCloseAutoFocus={(e) => {
                      if (!toPaste.current) return
                      toPaste.current = false
                      e.preventDefault()
                      pasteBox.current?.focus()
                    }}
                  >
                    <DropdownMenuItem
                      onSelect={() => {
                        toPaste.current = true
                        setPasting(true)
                      }}
                    >
                      <ClipboardPaste /> Paste dates…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                      <FileUp /> Open .ics file…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {fieldErrors.name && (
              <p className="text-[11px] text-destructive">{fieldErrors.name}</p>
            )}
          </DialogHeader>

          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem]">
              <div className="min-w-0">
                <YearStepper
                  year={year}
                  thisYear={thisYear}
                  onYear={changeYear}
                />
                <HolidayYear
                  year={year}
                  days={days}
                  today={today}
                  focusIso={focusIso}
                  onFocusDay={onFocusDay}
                  onToggle={onToggle}
                  readOnly={readOnly}
                />
              </div>
              <div className="relative min-h-64">
                <div className="flex flex-col gap-2 lg:absolute lg:inset-0">
                  {pasting ? (
                    <PastePanel
                      boxRef={pasteBox}
                      format={settings.date_format}
                      onCancel={() => setPasting(false)}
                      onAdd={(incoming) => {
                        if (importDays(incoming, [])) setPasting(false)
                      }}
                    />
                  ) : (
                    <>
                      {notice && (
                        <div className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-2.5 text-xs">
                          <div className="min-w-0 flex-1">
                            <span className="font-medium">{notice.title}</span>
                            {notice.detail && (
                              <span className="text-muted-foreground">
                                {" "}
                                · {notice.detail}
                              </span>
                            )}
                          </div>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setDays(notice.before)
                              setNotice(null)
                            }}
                          >
                            Undo
                          </Button>
                        </div>
                      )}
                      <div className="flex shrink-0 items-baseline justify-between gap-2">
                        <h3 className="text-sm font-medium whitespace-nowrap">
                          Holidays in <span className="num">{year}</span>
                        </h3>
                        {shown.length > 0 && (
                          <span className="num text-xs whitespace-nowrap text-muted-foreground">
                            {plural(shown.length, "day")}
                          </span>
                        )}
                      </div>
                      {fieldErrors.dates && (
                        <p className="shrink-0 text-[11px] text-destructive">
                          {fieldErrors.dates}
                        </p>
                      )}
                      {shown.length === 0 ? (
                        <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 text-center">
                          <p className="text-sm font-medium">
                            No holidays in {year}.
                          </p>
                          {!readOnly && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              Click a day to add it.
                            </p>
                          )}
                        </div>
                      ) : (
                        <DayList
                          listRef={listRef}
                          shown={shown}
                          format={settings.date_format}
                          readOnly={readOnly}
                          onRename={(key, v) =>
                            edit((d) => renameDay(d, key, v))
                          }
                          onYearly={(key, on, iso) =>
                            edit((d) => setYearly(d, key, on, iso))
                          }
                          onRemove={(key) => edit((d) => removeDay(d, key))}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {readOnly ? (
            <DialogFooter className="shrink-0">
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          ) : (
            <FormFooter
              className="shrink-0"
              onCancel={requestClose}
              submitting={save.isPending}
              submitLabel={calendar ? "Save" : "Create"}
            />
          )}
        </form>
        <input
          ref={fileRef}
          type="file"
          accept=".ics,text/calendar"
          className="hidden"
          onChange={onFile}
        />
        <LeaveGuardDialog
          blocker={{
            status: askDiscard ? "blocked" : "idle",
            proceed: onClose,
            reset: () => setAskDiscard(false),
          }}
          description="This calendar has unsaved changes."
        />
      </DialogContent>
    </Dialog>
  )
}

function YearStepper({
  year,
  thisYear,
  onYear,
}: {
  year: number
  thisYear: number
  onYear: (y: number) => void
}) {
  const step = (label: string, by: number, Icon: typeof ChevronLeft) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={year + by < MIN_YEAR || year + by > MAX_YEAR}
          onClick={() => onYear(year + by)}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent variant="default">{label}</TooltipContent>
    </Tooltip>
  )
  return (
    <div className="mb-3 flex items-center gap-1">
      {step("Previous year", -1, ChevronLeft)}
      <span
        aria-live="polite"
        className="num w-12 text-center text-sm font-medium"
      >
        {year}
      </span>
      {step("Next year", 1, ChevronRight)}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        // Invisible, not gone: the stepper keeps its width either way.
        className={cn("ml-1", year === thisYear && "invisible")}
        onClick={() => onYear(thisYear)}
      >
        This year
      </Button>
    </div>
  )
}

function DayList({
  listRef,
  shown,
  format,
  readOnly,
  onRename,
  onYearly,
  onRemove,
}: {
  listRef: RefObject<HTMLDivElement | null>
  shown: { iso: string; day: HolidayDay }[]
  format: DateFormat
  readOnly: boolean
  onRename: (key: string, name: string) => void
  onYearly: (key: string, on: boolean, iso: string) => void
  onRemove: (key: string) => void
}) {
  return (
    <div ref={listRef} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto_auto] items-center gap-x-2">
        <div className="col-span-4 grid grid-cols-subgrid pb-1 text-[11px] whitespace-nowrap text-muted-foreground">
          <span>Day</span>
          <span>Name</span>
          <span className="flex items-center gap-1">
            Every year
            <InfoTip>
              Repeats on this date every year. 29 February repeats in leap years
              only.
            </InfoTip>
          </span>
          <span />
        </div>
        {shown.map(({ iso, day }) => {
          const key = dayKey(day)
          return (
            <div
              key={iso}
              data-row={iso}
              className="col-span-4 grid min-h-8 grid-cols-subgrid items-center"
            >
              <span
                className={cn(
                  "num text-xs whitespace-nowrap",
                  isWeekend(iso) && "text-muted-foreground"
                )}
              >
                {dayLabel(iso, format)}
              </span>
              {readOnly ? (
                <span className="truncate text-xs">{day.name}</span>
              ) : (
                <Input
                  value={day.name}
                  onChange={(e) => onRename(key, e.target.value)}
                  placeholder="Name"
                  maxLength={NAME_MAX}
                  aria-label={`Name for ${dayMonth(iso)}`}
                  className="h-7 text-xs"
                />
              )}
              <Switch
                size="sm"
                checked={day.yearly}
                disabled={readOnly}
                onCheckedChange={(on) => onYearly(key, on, iso)}
                aria-label={`Every year: ${dayMonth(iso)}`}
                className="justify-self-center"
              />
              {readOnly ? (
                <span />
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${dayMonth(iso)}`}
                      onClick={() => onRemove(key)}
                    >
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent variant="default">Remove</TooltipContent>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PastePanel({
  boxRef,
  format,
  onCancel,
  onAdd,
}: {
  /** The dates box. The menu that opens this panel focuses it as it closes:
   * while the menu is open it holds the focus. */
  boxRef: RefObject<HTMLTextAreaElement | null>
  format: DateFormat
  onCancel: () => void
  onAdd: (days: HolidayDay[]) => void
}) {
  const [text, setText] = useState("")
  const parsed = useMemo(() => parsePasted(text, format), [text, format])
  const n = parsed.days.length
  const root = useRef<HTMLDivElement>(null)
  const add = () => n > 0 && onAdd(parsed.days)
  const addRef = useRef(add)
  useEffect(() => {
    addRef.current = add
  })

  useEffect(() => {
    const el = root.current
    // Ctrl/⌘+Enter here adds the dates. The form footer listens for the same
    // keys on the form and would save the calendar without them.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        addRef.current()
      }
    }
    el?.addEventListener("keydown", onKey)
    return () => el?.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col gap-2">
      <Field
        label="Dates"
        info={`${pasteFormats(format)}, one per line or separated by commas. Text beside a date names it.`}
      >
        <Textarea
          ref={boxRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"2026-12-24 Christmas Eve\n2026-12-25 Christmas Day"}
          aria-label="Dates"
          // It grows with what is pasted, up to a point, then scrolls.
          className="max-h-96 min-h-56"
        />
      </Field>
      {parsed.errors.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-destructive">
          {parsed.errors.slice(0, 3).map((e) => (
            <li key={e}>{e}</li>
          ))}
          {parsed.errors.length > 3 && (
            <li>and {parsed.errors.length - 3} more</li>
          )}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={n === 0} onClick={add}>
          {n > 0 ? `Add ${plural(n, "day")}` : "Add"}
        </Button>
      </div>
    </div>
  )
}
