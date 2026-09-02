/**
 * timezone.ts — wall clock to instant, without a dependency.
 *
 * Free-slot search is stated in wall-clock terms ("09:00 to 18:00, weekdays"),
 * while busy blocks are instants. Something has to convert between them, and
 * doing it with a fixed -03:00 would be wrong in two ways: other calendars can
 * be in other zones, and Brazil's lack of DST since 2019 is a fact about today,
 * not a property of the code.
 *
 * Everything here goes through Intl, which carries the IANA rules. Pure module.
 */

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday, as in Date#getUTCDay. */
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(0)
    return true
  } catch {
    return false
  }
}

/** Wall-clock parts of an instant, in the given zone. */
export function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instantMs)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
  const year = get("year")
  const month = get("month")
  const day = get("day")
  return {
    year,
    month,
    day,
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  }
}

/** Offset of the zone at that instant, in milliseconds (east of UTC positive). */
export function tzOffsetMs(instantMs: number, timeZone: string): number {
  const p = zonedParts(instantMs, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // The instant may carry sub-second precision the formatter dropped.
  return asUtc - Math.floor(instantMs / 1000) * 1000
}

/**
 * Instant for a wall-clock time in a zone. Two passes: the first guesses the
 * offset from the naive UTC reading, the second re-reads it at the corrected
 * instant, which is what makes DST transitions land right in zones that have
 * them.
 */
export function wallToInstant(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string
): number {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  )
  let instant = naive - tzOffsetMs(naive, timeZone)
  instant = naive - tzOffsetMs(instant, timeZone)
  return instant
}

function pad(n: number, width = 2): string {
  return String(Math.abs(n)).padStart(width, "0")
}

/** "-03:00" for an offset in milliseconds. */
export function formatOffset(offsetMs: number): string {
  if (offsetMs === 0) return "Z"
  const sign = offsetMs < 0 ? "-" : "+"
  const totalMinutes = Math.round(Math.abs(offsetMs) / 60000)
  return `${sign}${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`
}

/** RFC3339 with an explicit offset. Never a bare local time. */
export function toRfc3339(instantMs: number, timeZone: string): string {
  const p = zonedParts(instantMs, timeZone)
  const offset = formatOffset(tzOffsetMs(instantMs, timeZone))
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`
  )
}

/** Start of a plain date (all-day boundary) in the given zone. */
export function dateOnlyToInstant(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number)
  return wallToInstant({ year: y ?? 1970, month: m ?? 1, day: d ?? 1 }, timeZone)
}

/** "09:00" to minutes past midnight. Returns null when unparseable. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}
