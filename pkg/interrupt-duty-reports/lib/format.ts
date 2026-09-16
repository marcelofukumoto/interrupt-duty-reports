// How the report's vocabulary is shown.
//
// One place for it, because the same four classes and the same dozen verbs appear on the list
// row, in the Top 3, and on every item in every section - and a class that is red in one of
// them and orange in another reads as two different things.
import type { ItemClass, ReportMeta, RunStatus } from '../types';

export interface ClassStyle {
  label: string;
  /** A Rancher status colour variable, used for the stripe, the dot and the badge. */
  colorVar: string;
  icon: string;
  /** What this class means, for the badge's tooltip. */
  hint: string;
}

const CLASSES: Record<ItemClass, ClassStyle> = {
  ACT_NOW: {
    label: 'Act now', colorVar: '--error', icon: 'icon-warning', hint: 'The ball is ours — this needs a move today.',
  },
  FOLLOW_UP: {
    label: 'Follow up', colorVar: '--warning', icon: 'icon-alert', hint: 'We replied last and it has been idle 14 days or more.',
  },
  WAITING: {
    label: 'Waiting', colorVar: '--info', icon: 'icon-time', hint: 'We replied recently — too soon for a nudge.',
  },
  TRACKED: {
    label: 'Tracked', colorVar: '--success', icon: 'icon-checkmark', hint: 'It has an owner or a linked PR that is moving.',
  },
};

const UNKNOWN_CLASS: ClassStyle = {
  label: 'Unclassified', colorVar: '--muted', icon: 'icon-help', hint: 'The agent did not give this item a class.',
};

export function classStyle(value?: string | null): ClassStyle {
  return CLASSES[value as ItemClass] || UNKNOWN_CLASS;
}

export const CLASS_ORDER: ItemClass[] = ['ACT_NOW', 'FOLLOW_UP', 'WAITING', 'TRACKED'];

export interface StatusStyle {
  label: string;
  colorVar: string;
}

const STATUSES: Record<RunStatus, StatusStyle> = {
  running:   { label: 'Running', colorVar: '--info' },
  complete:  { label: 'Ready', colorVar: '--success' },
  failed:    { label: 'Failed', colorVar: '--error' },
  cancelled: { label: 'Stopped', colorVar: '--warning' },
};

export function statusStyle(status?: string | null): StatusStyle {
  return STATUSES[status as RunStatus] || { label: String(status || 'Unknown'), colorVar: '--muted' };
}

/**
 * A verb's weight, so the strongest recommendation on a card is the one that looks strongest.
 *
 * "Act" is something owed to somebody outside the team today; "chase" is a reminder we choose
 * to send; "watch" is work already moving. Anything unrecognised is shown plainly rather than
 * guessed at.
 */
export type VerbWeight = 'act' | 'chase' | 'watch' | 'plain';

const VERB_WEIGHTS: Record<string, VerbWeight> = {
  TRIAGE:           'act',
  RESPOND:          'act',
  'NEEDS INFO':     'act',
  'NEEDS GH ISSUE': 'act',
  'CONFIRM OWNER':  'act',
  'RE-TRIAGE':      'act',
  REASSIGN:         'act',
  CLOSE:            'act',
  NUDGE:            'chase',
  'STATUS REQUEST': 'chase',
  'TRACK PR':       'watch',
  'TRACK ISSUE':    'watch',
};

export function verbWeight(verb?: string | null): VerbWeight {
  return VERB_WEIGHTS[String(verb || '').toUpperCase()] || 'plain';
}

/** "3d", "just now", "21d" — the unit the whole report ages things in. */
export function ageLabel(days?: number | null): string {
  if (days === null || days === undefined) {
    return '—';
  }
  if (days <= 0) {
    return 'today';
  }

  return `${ days }d`;
}

/** A local, human timestamp. The ids are UTC; a person reading the list is not. */
export function whenLabel(iso?: string | null): string {
  if (!iso) {
    return '';
  }

  const at = new Date(iso);

  if (Number.isNaN(at.getTime())) {
    return '';
  }

  return at.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** How long a run has been going, for the line under a report that is still running. */
export function elapsedLabel(meta: ReportMeta, now = Date.now()): string {
  const started = Date.parse(meta.startedAt || '');

  if (Number.isNaN(started)) {
    return '';
  }

  const end = meta.finishedAt ? Date.parse(meta.finishedAt) : now;
  const seconds = Math.max(0, Math.round(((Number.isNaN(end) ? now : end) - started) / 1000));

  if (seconds < 60) {
    return `${ seconds }s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${ minutes }m ${ seconds % 60 }s` : `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`;
}

/**
 * How long a run may sit on "running" before the page stops believing it.
 *
 * A pod that was restarted mid-run takes its conversation with it and nothing is left to
 * publish a failure, so the row would stay "running" for ever. Twenty minutes is longer than
 * any report has taken and short enough that somebody looking at yesterday's list is not
 * misled about what is happening now.
 */
export const STALE_AFTER_MS = 20 * 60 * 1000;

export function isStale(meta: ReportMeta, now = Date.now()): boolean {
  if (meta.status !== 'running') {
    return false;
  }

  const started = Date.parse(meta.startedAt || '');

  return !Number.isNaN(started) && now - started > STALE_AFTER_MS;
}

/** The phase labels, in the order a run passes through them. */
export const PHASE_LABEL: Record<string, string> = {
  starting:   'Starting the agent',
  gathering:  'Reading Jira and GitHub',
  analysing:  'Writing the report',
  publishing: 'Storing it in the cluster',
};

/**
 * Everything a row can be searched by, lowercased.
 *
 * The refs matter as much as the date: "was SURE-11670 on a report last week" is the question
 * somebody actually has, and it is unanswerable if search only reads the headline.
 */
export function searchText(meta: ReportMeta): string {
  return [
    meta.reportDate,
    meta.headline || '',
    meta.error || '',
    meta.startedBy || '',
    ...(meta.top3 || []).flatMap((t) => [t.ref, t.title]),
  ].join(' ').toLowerCase();
}

/**
 * The trend of how much was owed on each of the last reports, oldest first.
 *
 * Only complete reports: a run that failed has no count, and a gap drawn as zero would read as
 * a quiet day rather than a missing one.
 */
export function actNowTrend(reports: ReportMeta[], points = 12): { date: string; value: number }[] {
  return reports
    .filter((r) => r.status === 'complete' && typeof r.actNow === 'number')
    .slice(0, points)
    .reverse()
    .map((r) => ({ date: r.reportDate, value: r.actNow as number }));
}
