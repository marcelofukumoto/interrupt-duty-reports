// Where the reports live: ConfigMaps in the cluster, which is what makes them survive.
//
// The console this replaces wrote markdown into a pod's filesystem and lost the lot whenever
// that pod was replaced. A report is now a pair of ConfigMaps in a namespace of its own, so it
// outlives the agent pod, the extension, and a Rancher restart, and every admin sees the same
// list.
//
// Two objects per report, not one:
//
//   <id>          summary - meta.json, a few hundred bytes. Every one of these is fetched to
//                 draw the list.
//   <id>-report   payload - report.json, the report itself. Fetched only when somebody opens
//                 one.
//
// Put together, drawing a hundred rows of dates would mean downloading a hundred reports in
// full. They are found by label rather than by name pattern, so nothing here guesses at what a
// ConfigMap is from its name.
import type { Report, ReportMeta, RunStatus } from '../types';

const CLUSTER = 'local';
const STEVE = `/k8s/clusters/${ CLUSTER }/v1`;

export const NAMESPACE = 'interrupt-duty-reports-console';

const LABEL = 'interrupt-duty.rancher.io';
const LABEL_PART = `${ LABEL }/report`;
const LABEL_ID = `${ LABEL }/report-id`;

/** The cap. The oldest goes when a new one arrives past it - enforced here and in publish.sh. */
export const MAX_REPORTS = 100;

function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

async function steve(path: string, init?: RequestInit): Promise<any> {
  const write = !!init?.method && init.method !== 'GET';
  const resp = await fetch(`${ STEVE }${ path }`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(write ? csrfHeader() : {}),
      ...(init?.headers || {}),
    },
  });

  if (resp.status === 404) {
    return null;
  }

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.message || data.error || `HTTP ${ resp.status }`);
  }

  return data;
}

/**
 * The namespace, made on the way past.
 *
 * Every user of this extension is a Rancher admin - that is the premise the whole thing is
 * built on - so the first person to open the page is somebody who can make it. A 409 is two
 * tabs doing it at once, which is the outcome both wanted.
 */
export async function ensureNamespace(): Promise<void> {
  const existing = await steve(`/namespaces/${ NAMESPACE }`).catch(() => null);

  if (existing) {
    return;
  }

  await steve('/namespaces', {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Namespace',
      metadata:   {
        name:   NAMESPACE,
        labels: { [LABEL_PART]: 'store' },
      },
    }),
  }).catch((e: any) => {
    if (!/409|already exists|alreadyexists/i.test(e?.message || '')) {
      throw e;
    }
  });
}

function parseMeta(cm: any): ReportMeta | null {
  const raw = cm?.data?.['meta.json'];

  if (!raw) {
    return null;
  }

  try {
    const meta = JSON.parse(raw) as ReportMeta;

    // The object's own name wins over whatever is inside it: the name is what every other call
    // here addresses, and a meta.json copied from another report would otherwise point the
    // Delete button at the wrong one.
    meta.id = cm.metadata?.name || meta.id;

    return meta;
  } catch {
    return null;
  }
}

/**
 * Every report, newest first.
 *
 * Sorted on `startedAt` rather than on the name, because a report's name carries the date it
 * was *for* and two runs on one day are told apart by the time in it - which is the same
 * ordering right up until somebody regenerates yesterday's.
 */
export async function listReports(): Promise<ReportMeta[]> {
  // STEVE IGNORES `labelSelector`. Not rejects - ignores: the request answers 200 with every
  // ConfigMap in every namespace of the cluster, and a caller that trusts the parameter is
  // reading other people's objects believing they matched. The sibling console shipped that
  // and put one board's pull request on another board's row; here it was hidden only because
  // anything without a readable meta.json is dropped, which is luck rather than a filter.
  //
  // So: ask for the collection by namespace, which is a path segment Steve does honour, and
  // check the label here on what actually came back.
  const list = await steve(`/configmaps/${ NAMESPACE }`).catch(() => null);
  const items: any[] = (list?.data || []).filter((cm: any) => (
    cm?.metadata?.namespace === NAMESPACE &&
    (cm?.metadata?.labels || {})[LABEL_PART] === 'summary'
  ));

  return items
    .map(parseMeta)
    .filter((m): m is ReportMeta => !!m)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

/** One report's payload, or null when the summary is there and the report behind it is not. */
export async function getReport(id: string): Promise<Report | null> {
  const cm = await steve(`/configmaps/${ NAMESPACE }/${ id }-report`).catch(() => null);
  const raw = cm?.data?.['report.json'];

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as Report;
  } catch {
    throw new Error('This report was stored in a form that cannot be read back.');
  }
}

export async function getMeta(id: string): Promise<ReportMeta | null> {
  const cm = await steve(`/configmaps/${ NAMESPACE }/${ id }`).catch(() => null);

  return cm ? parseMeta(cm) : null;
}

/**
 * Record a run that has just started.
 *
 * Written before the agent is asked for anything, so a run always has a row: a conversation
 * that never starts, or a browser closed in the middle of setting one up, has to be visible as
 * a run that failed rather than as nothing at all.
 */
export async function createRunning(meta: ReportMeta): Promise<void> {
  await ensureNamespace();

  await steve('/configmaps', {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   {
        name:      meta.id,
        namespace: NAMESPACE,
        labels:    { [LABEL_PART]: 'summary', [LABEL_ID]: meta.id },
      },
      data: { 'meta.json': JSON.stringify(meta) },
    }),
  });
}

/**
 * Change a run's summary in place.
 *
 * Read-modify-write on the whole object, because Steve wants the resourceVersion back and a
 * ConfigMap this small is not worth a patch. `mutate` is given what is stored now, so a caller
 * cannot overwrite a status the agent has since published - the agent publishes through
 * publish.sh and the two do meet, when somebody presses Stop on a run that was finishing.
 */
export async function updateMeta(id: string, mutate: (meta: ReportMeta) => ReportMeta): Promise<ReportMeta | null> {
  const cm = await steve(`/configmaps/${ NAMESPACE }/${ id }`).catch(() => null);

  if (!cm) {
    return null;
  }

  const current = parseMeta(cm);

  if (!current) {
    return null;
  }

  const next = mutate(current);

  cm.data = { ...(cm.data || {}), 'meta.json': JSON.stringify(next) };

  await steve(`/configmaps/${ NAMESPACE }/${ id }`, { method: 'PUT', body: JSON.stringify(cm) });

  return next;
}

export async function setStatus(id: string, status: RunStatus, error?: string): Promise<void> {
  await updateMeta(id, (meta) => ({
    ...meta,
    status,
    error:      error ?? meta.error,
    finishedAt: status === 'running' ? meta.finishedAt : new Date().toISOString(),
  }));
}

/** A report and the payload behind it, both, so nothing is left orphaned in the namespace. */
export async function deleteReport(id: string): Promise<void> {
  await Promise.all([
    steve(`/configmaps/${ NAMESPACE }/${ id }`, { method: 'DELETE' }).catch(() => null),
    steve(`/configmaps/${ NAMESPACE }/${ id }-report`, { method: 'DELETE' }).catch(() => null),
  ]);
}

/**
 * Bring the list back under the cap.
 *
 * publish.sh already does this in the pod at the end of a successful run, which is the moment
 * the cap can actually be exceeded. This is the same rule applied from the page, for the runs
 * that end some other way - a failure, a Stop - and for a list that was over the cap before
 * either of them existed.
 */
export async function pruneToCap(keep = MAX_REPORTS): Promise<number> {
  const reports = await listReports();
  const excess = reports.slice(keep);

  for (const report of excess) {
    await deleteReport(report.id);
  }

  return excess.length;
}
