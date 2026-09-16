// The month grid the reports are laid out on.
//
// A report is a daily thing, and the one question a list of them cannot answer is the one people
// actually have: did we do this every day. A row that is missing looks exactly like a row that
// was never scrolled to, whereas an empty square on a calendar is a gap you can see - so the
// gaps, the weekends and the run of days with nothing owed all become readable at a glance.
//
// All the arithmetic is UTC, because a report's date is the UTC date it covers. Building the
// grid in local time would slide the whole month by a day for anybody west of Greenwich.
import type { ReportMeta } from '../types';

export interface CalendarDay {
  /** `YYYY-MM-DD`, which is how a report names the day it covers. */
  date: string;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  /** Newest first, so the first is the one a click opens. */
  reports: ReportMeta[];
}

export interface CalendarMonth {
  year: number;
  /** 0-11, as Date uses. */
  month: number;
  label: string;
  weeks: CalendarDay[][];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function ymd(date: Date): string {
  return `${ date.getUTCFullYear() }-${ pad(date.getUTCMonth() + 1) }-${ pad(date.getUTCDate()) }`;
}

/** Monday first. Interrupt duty is a working-week rota, so the weekend belongs at the end. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * The weeks of one month, with the days either side that share its first and last weeks.
 *
 * Those neighbouring days are drawn rather than left blank - a report on the 31st of last month
 * is still a report, and a square that is empty because nothing ran must look different from one
 * that is empty because it belongs to another month.
 */
export function buildMonth(year: number, month: number, reports: ReportMeta[], now = new Date()): CalendarMonth {
  const byDate = new Map<string, ReportMeta[]>();

  for (const report of reports) {
    const list = byDate.get(report.reportDate);

    if (list) {
      list.push(report);
    } else {
      byDate.set(report.reportDate, [report]);
    }
  }

  for (const list of byDate.values()) {
    list.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }

  const first = new Date(Date.UTC(year, month, 1));
  // getUTCDay is Sunday-based; this is the offset back to the Monday on or before the 1st.
  const lead = (first.getUTCDay() + 6) % 7;
  const cursor = new Date(Date.UTC(year, month, 1 - lead));
  const today = ymd(now);
  const weeks: CalendarDay[][] = [];

  // Whole weeks until the month is covered, so a month that spans six is given six and one that
  // fits in five is not padded with a blank row.
  while (true) {
    const week: CalendarDay[] = [];

    for (let i = 0; i < 7; i++) {
      const date = ymd(cursor);
      const day = cursor.getUTCDay();

      week.push({
        date,
        dayOfMonth: cursor.getUTCDate(),
        inMonth:    cursor.getUTCMonth() === month && cursor.getUTCFullYear() === year,
        isToday:    date === today,
        isWeekend:  day === 0 || day === 6,
        reports:    byDate.get(date) || [],
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    weeks.push(week);

    const past = cursor.getUTCFullYear() > year || (cursor.getUTCFullYear() === year && cursor.getUTCMonth() > month);

    if (past || weeks.length >= 6) {
      break;
    }
  }

  return {
    year, month, label: monthLabel(year, month), weeks,
  };
}

export function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const moved = new Date(Date.UTC(year, month + by, 1));

  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() };
}

/**
 * How loud a day's square is, from how much was owed on it.
 *
 * A sequential scale - one hue, five steps - because this is a magnitude across a grid, which is
 * the one job a heatmap is for. The count itself is printed in the square as well, so the colour
 * is the second way of reading it and never the only one.
 */
export function actNowLevel(count: number | undefined | null): 0 | 1 | 2 | 3 | 4 {
  if (!count) {
    return 0;
  }
  if (count <= 2) {
    return 1;
  }
  if (count <= 5) {
    return 2;
  }

  return count <= 9 ? 3 : 4;
}
