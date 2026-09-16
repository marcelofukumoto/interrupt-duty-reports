// What changed since the last report.
//
// The question interrupt duty actually asks on opening a report is not "what is on the list"
// but "what is on it that was not on it yesterday" - a ticket appearing for the first time is a
// new obligation, and one appearing for the fourth day running is the report telling you the
// queue is not moving. Neither is visible in a list where every item looks the same.
//
// Computed in the browser by comparing two reports that are already stored, so it costs one
// extra ConfigMap read and nothing from the agent. The report format is unchanged: this is a
// reading of two reports, not a field either of them carries.
import type { GitHubItem, JiraItem, QuestionItem, Report } from '../types';

/** How an item is named across reports: the Jira key, or `#` and the issue number. */
export function itemRef(item: JiraItem | GitHubItem | QuestionItem): string {
  return 'key' in item ? item.key : `#${ item.number }`;
}

function allItems(report: Report): (JiraItem | GitHubItem | QuestionItem)[] {
  return [
    ...(report.jira?.new || []),
    ...(report.jira?.in_triage || []),
    ...(report.jira?.waiting_reporter || []),
    ...(report.github?.issues || []),
    ...(report.github?.questions || []),
  ];
}

export function reportRefs(report: Report): Set<string> {
  return new Set(allItems(report).map(itemRef));
}

export interface ReportDelta {
  /** The report this one is being compared against. */
  previousDate: string;
  /** Refs on this report that were not on the previous one. */
  fresh: Set<string>;
  /** Refs on both - still open, still ours. */
  carried: Set<string>;
  /** Refs that were on the previous report and are not on this one. */
  clearedCount: number;
}

/**
 * Compare a report with the one before it.
 *
 * Only ever the immediately preceding report, deliberately. "How many days has this been
 * sitting here" would need every report back to the item's first appearance, which is a fetch
 * per report for an answer that "since <date>" already gives well enough.
 */
export function computeDelta(current: Report, previous: Report | null, previousDate: string): ReportDelta | null {
  if (!previous) {
    return null;
  }

  const before = reportRefs(previous);
  const now = reportRefs(current);
  const fresh = new Set<string>();
  const carried = new Set<string>();

  for (const ref of now) {
    (before.has(ref) ? carried : fresh).add(ref);
  }

  let clearedCount = 0;

  for (const ref of before) {
    if (!now.has(ref)) {
      clearedCount++;
    }
  }

  return {
    previousDate, fresh, carried, clearedCount,
  };
}
