// Which of the two views somebody last chose.
//
// In localStorage rather than in a Rancher user preference, because that is the honest home for
// it: this is a per-browser convenience, not a setting the cluster needs to know about, and a
// Rancher preference would mean shipping a schema for one string.
//
// Every access is guarded. localStorage throws outright in a private window and in a browser
// with site data blocked, and reading a value somebody edited by hand must not be able to
// produce a view that does not exist - so an unreadable or unrecognised value is simply the
// default, which is the calendar.
export type ReportsView = 'calendar' | 'list';

export const DEFAULT_VIEW: ReportsView = 'calendar';

const KEY = 'interrupt-duty-reports-console.view';

function isView(value: unknown): value is ReportsView {
  return value === 'calendar' || value === 'list';
}

export function loadView(): ReportsView {
  try {
    const stored = window.localStorage.getItem(KEY);

    return isView(stored) ? stored : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: ReportsView): void {
  try {
    window.localStorage.setItem(KEY, view);
  } catch {
    // A browser that will not store it is a browser that gets the default next time, which is
    // a smaller problem than an unhandled exception on a click.
  }
}
