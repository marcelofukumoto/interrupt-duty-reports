<script setup lang="ts">
// The whole extension, as a page: the buttons, the run in flight, and the month.
//
// Laid out as a calendar rather than a list because a report is a daily thing, and the question
// a list cannot answer is the one people have - did this happen every day. A row that is missing
// looks exactly like a row nobody scrolled to; an empty square is a gap you can see.
//
// Generate and Stop are in the header, because there is only ever one run in flight and it
// belongs to the page rather than to any day. A run in progress gets a strip of its own above
// the month: four steps do not fit in a calendar square, and what a run is doing right now
// matters more than where it will eventually land.
import {
  computed, onBeforeUnmount, onMounted, ref,
} from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import CalendarGrid from '../components/CalendarGrid.vue';
import CredentialsDialog from '../components/CredentialsDialog.vue';
import ReportPanel from '../components/ReportPanel.vue';
import RunProgress from '../components/RunProgress.vue';
import TrendTile from '../components/TrendTile.vue';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import type { AgentsStatus } from '../lib/agents';
import {
  deleteReport, listReports, MAX_REPORTS, pruneToCap, setStatus,
} from '../lib/store';
import {
  runProgress, startRun, stopRun, sweepFinishedRuns, sweepRunDirectories,
} from '../lib/run';
import type { RunProgress as Progress } from '../lib/run';
import { actNowTrend, elapsedLabel, isStale, searchText } from '../lib/format';
import type { ReportMeta } from '../types';

const store = useStore();

const reports = ref<ReportMeta[]>([]);
const agents = ref<AgentsStatus>({
  state: 'checking', version: null, pod: null, detail: 'Looking for the Agents extension…',
});
const loading = ref(true);
const error = ref('');
const askingForTokens = ref(false);
const starting = ref(false);
const stopping = ref(false);
const progress = ref<Progress | null>(null);
const query = ref('');
const searchBox = ref<HTMLInputElement | null>(null);
/** The tab's memory of the two tokens, so a second report in one sitting is one click. */
const remembered = ref({ jiraPat: '', ghToken: '' });

const now = new Date();
const shown = ref({ year: now.getUTCFullYear(), month: now.getUTCMonth() });

const POLL_RUNNING_MS = 4000;
const POLL_IDLE_MS = 45000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
/**
 * The run that was in flight on the previous tick, so the tick where a run *stops* being in
 * flight is identifiable - that is the one moment its conversation can be ended.
 */
let previousRun: string | null = null;

const activeRun = computed(() => reports.value.find((r) => r.status === 'running') || null);
const canGenerate = computed(() => agents.value.state === 'ready' && !activeRun.value && !starting.value);
const trend = computed(() => actNowTrend(reports.value));

/** Which reports a search matched. Null when nothing is being searched for. */
const matched = computed<Set<string> | null>(() => {
  const needle = query.value.trim().toLowerCase();

  if (!needle) {
    return null;
  }

  return new Set(reports.value.filter((r) => searchText(r).includes(needle)).map((r) => r.id));
});

const matchesElsewhere = computed(() => {
  if (!matched.value) {
    return 0;
  }

  return reports.value.filter((r) => {
    if (!matched.value?.has(r.id)) {
      return false;
    }

    const [year, month] = r.reportDate.split('-').map(Number);

    return year !== shown.value.year || month - 1 !== shown.value.month;
  }).length;
});

/**
 * The report each one is compared against: the next complete report older than it.
 *
 * Worked out here rather than in the panel because only this page holds the whole list, and the
 * panel is handed one report.
 */
const previousComplete = computed(() => {
  const map = new Map<string, ReportMeta>();
  const complete = reports.value.filter((r) => r.status === 'complete');

  complete.forEach((report, i) => {
    const older = complete[i + 1];

    if (older) {
      map.set(report.id, older);
    }
  });

  return map;
});

async function refresh() {
  try {
    reports.value = await listReports();
    error.value = '';
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

/**
 * Clear up after runs that are over.
 *
 * A finished report leaves a conversation in the agent pod with an idle claude in it, because
 * the pane runs claude in a loop so that it survives a crash - and a gathered data file beside
 * it. Neither goes away on its own, so a hundred reports would be a hundred of each.
 *
 * Best-effort, and never surfaced: this is housekeeping, and a pod that has just restarted
 * failing to answer it is not something to put a red banner over a month that is otherwise fine.
 */
async function sweep() {
  const running = reports.value.filter((r) => r.status === 'running');

  await sweepFinishedRuns(running.map((r) => r.session || '')).catch(() => undefined);
  await sweepRunDirectories(reports.value.map((r) => r.id)).catch(() => undefined);
}

/**
 * The one loop. It reschedules itself rather than running on an interval, so a slow cluster
 * makes the next check later instead of stacking another one on top of it.
 */
function schedule() {
  if (stopped) {
    return;
  }

  timer = setTimeout(async() => {
    await refresh();

    const run = activeRun.value;

    if (run) {
      // A pod that was restarted mid-run took the conversation with it, and nothing is left to
      // publish an outcome - so the page is what finally says the run is not coming back.
      if (isStale(run)) {
        await setStatus(run.id, 'failed', 'The run stopped reporting — the agent pod was probably restarted. Generate it again.').catch(() => undefined);
        progress.value = null;
        await refresh();
      } else {
        progress.value = await runProgress(run).catch(() => null);
      }
    } else if (previousRun) {
      // The tick on which a run stopped being in flight is the moment to clear up after it.
      progress.value = null;
      await sweep();
    }

    previousRun = run?.id || null;

    schedule();
  }, activeRun.value ? POLL_RUNNING_MS : POLL_IDLE_MS);
}

function restartPolling() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  schedule();
}

/** `/` to search and Escape to clear it, which is what every list in this dashboard does. */
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchBox.value?.focus();
  } else if (event.key === 'Escape' && target === searchBox.value) {
    query.value = '';
    searchBox.value?.blur();
  }
}

onMounted(async() => {
  // The agents bundle may not have installed its API yet: two extensions on one page load in
  // whatever order Rancher loaded them.
  await whenAgentsReady();
  agents.value = await agentsStatus();

  await refresh();
  loading.value = false;

  window.addEventListener('keydown', onKeydown);

  // Anything over the cap from before is cleared once, quietly, on the way in - and with it
  // whatever earlier runs left in the pod, including any whose browser tab was closed on them.
  pruneToCap(MAX_REPORTS)
    .then((pruned) => (pruned ? refresh() : undefined))
    .then(() => sweep())
    .catch(() => undefined);

  schedule();
});

onBeforeUnmount(() => {
  stopped = true;
  window.removeEventListener('keydown', onKeydown);
  if (timer) {
    clearTimeout(timer);
  }
});

function openGenerate() {
  if (!canGenerate.value) {
    return;
  }
  askingForTokens.value = true;
}

async function generate(credentials: { jiraPat: string; ghToken: string }) {
  starting.value = true;
  error.value = '';

  try {
    remembered.value = credentials;
    const started = await startRun(credentials, store.getters['auth/principal']?.loginName || undefined);

    previousRun = started.id;
    askingForTokens.value = false;
    // A run always lands on today, so that is the month to be looking at.
    shown.value = { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() };
    await refresh();
    restartPolling();
  } catch (e: any) {
    error.value = e?.message || String(e);
    await refresh();
  } finally {
    starting.value = false;
  }
}

async function stop() {
  const run = activeRun.value;

  if (!run || stopping.value) {
    return;
  }

  stopping.value = true;

  try {
    await stopRun(run);
    progress.value = null;
    previousRun = null;
    await refresh();
    await sweep();
    restartPolling();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    stopping.value = false;
  }
}

async function remove(meta: ReportMeta) {
  try {
    // A report still running is a conversation still running: ending it first means deleting it
    // cannot leave a claude in the pod working on something nothing will ever read.
    if (meta.status === 'running') {
      await stopRun(meta).catch(() => undefined);
    }

    await deleteReport(meta.id);
    await refresh();
    await sweep();
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

function open(meta: ReportMeta) {
  const previous = previousComplete.value.get(meta.id);

  store.commit('slideInPanel/open', {
    component:      ReportPanel,
    componentProps: {
      title: `Daily report · ${ meta.reportDate }`,
      width: 'wide',
      meta,
      previousId:   previous?.id,
      previousDate: previous?.reportDate,
      onDelete:     remove,
    },
  });
}
</script>

<template>
  <div class="idr">
    <header class="idr__head">
      <div class="idr__titles">
        <h1 class="idr__title">
          Interrupt duty
        </h1>
        <p class="idr__lede">
          The day's Jira escalations and <code>rancher/dashboard</code> community issues — each
          with a next step and a comment you can send.
        </p>
      </div>

      <div class="idr__actions">
        <button
          type="button"
          class="btn role-primary"
          :disabled="!canGenerate"
          data-testid="idr-generate"
          :title="activeRun ? 'A report is already running' : agents.state !== 'ready' ? agents.detail : 'Generate today\'s report'"
          @click="openGenerate"
        >
          <i class="icon icon-play" />
          Generate report
        </button>
        <button
          type="button"
          class="btn role-secondary"
          :disabled="!activeRun || stopping"
          data-testid="idr-stop"
          title="Stop the run that is in flight"
          @click="stop"
        >
          <i class="icon icon-close" />
          {{ stopping ? 'Stopping…' : 'Stop' }}
        </button>
      </div>
    </header>

    <!--
      The agent's state is a one-line note while it is fine and a banner only when it is not. A
      full-width green bar saying everything works is a bar that is on screen every second of
      every day to report an absence of news.
    -->
    <Banner
      v-if="agents.state !== 'ready' && agents.state !== 'checking'"
      :color="agents.state === 'no-pod' ? 'warning' : 'error'"
      data-testid="idr-agents-banner"
    >
      <strong>Agents is not ready.</strong> {{ agents.detail }}
    </Banner>

    <Banner v-if="error" color="error">
      {{ error }}
    </Banner>

    <section v-if="activeRun" class="idr__running" data-testid="idr-running">
      <div class="idr__running-head">
        <i class="icon icon-spinner icon-spin" />
        <strong>Generating the report for {{ activeRun.reportDate }}</strong>
        <span>{{ elapsedLabel(activeRun) }}</span>
      </div>
      <RunProgress
        :phase="progress?.phase || 'starting'"
        :output="progress?.output || ''"
        :elapsed="elapsedLabel(activeRun)"
      />
    </section>

    <div v-if="loading" class="idr__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Loading reports…</span>
    </div>

    <template v-else>
      <section v-if="!reports.length" class="idr__empty" data-testid="idr-empty">
        <h2>No reports yet</h2>
        <p>
          Generating one takes a couple of minutes. The agent in this cluster reads the day's
          Jira queues and community issues, decides who owes the next move on each, and drafts
          the comment to send.
        </p>
        <ol class="idr__steps">
          <li><strong>Generate</strong> — you supply a Jira and a GitHub token for the run.</li>
          <li><strong>Watch it work</strong> — the four steps show as they happen.</li>
          <li><strong>Open the day</strong> — act on it, copying the drafted comments.</li>
        </ol>
      </section>

      <template v-else>
        <div class="idr__toolbar">
          <TrendTile v-if="trend.length > 1" :points="trend" />

          <label class="idr__search">
            <i class="icon icon-search" />
            <input
              ref="searchBox"
              v-model="query"
              type="search"
              placeholder="Search by date, ticket or summary…"
              aria-label="Search reports"
              data-testid="idr-search"
            >
            <kbd v-if="!query">/</kbd>
            <button v-else type="button" class="idr__search-clear" aria-label="Clear the search" @click="query = ''">
              <i class="icon icon-close" />
            </button>
          </label>
        </div>

        <p v-if="matched" class="idr__matches" data-testid="idr-matches">
          <template v-if="matched.size">
            <strong>{{ matched.size }}</strong>
            {{ matched.size === 1 ? 'report matches' : 'reports match' }} “{{ query }}”
            <template v-if="matchesElsewhere">
              · <strong>{{ matchesElsewhere }}</strong> in another month
            </template>
          </template>
          <template v-else>
            No report matches “{{ query }}”.
          </template>
        </p>

        <CalendarGrid
          :reports="reports"
          :year="shown.year"
          :month="shown.month"
          :matched="matched"
          @open="open"
          @month="shown = $event"
        />
      </template>

      <p class="idr__foot">
        <span v-if="agents.state === 'ready'" class="idr__agents">
          <i class="icon icon-checkmark" />
          Agents {{ agents.version }} · pod {{ agents.pod }}
        </span>
        <span>Keeping the newest {{ MAX_REPORTS }} reports.</span>
      </p>
    </template>

    <CredentialsDialog
      v-if="askingForTokens"
      :jira-pat="remembered.jiraPat"
      :gh-token="remembered.ghToken"
      :busy="starting"
      @cancel="askingForTokens = false"
      @run="generate"
    />
  </div>
</template>

<style lang="scss" scoped>
// Rancher's global `code` style is built for blocks: its padding turns a token name used
// mid-sentence into a tall box that breaks the line it is on. Inline code here is a word.
:deep(code) {
  padding: 1px 5px;
  font-size: 0.92em;
  line-height: inherit;
  vertical-align: baseline;
  border-radius: 3px;
}

.idr {
  padding: 20px;

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  &__titles {
    min-width: 0;
  }

  &__title {
    margin: 0 0 4px;
    font-size: 22px;
    font-weight: 600;
  }

  &__lede {
    margin: 0;
    max-width: 66ch;
    color: var(--muted);
    font-size: 13px;
    line-height: 19px;
  }

  &__actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  &__running {
    margin-bottom: 18px;
    padding: 12px 16px;
    border: 1px solid var(--info);
    border-radius: 8px;
    background: var(--body-bg);
  }

  &__running-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;

    .icon {
      color: var(--info);
    }

    span {
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
  }

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 40px 0;
    color: var(--muted);
  }

  &__empty {
    margin: 24px auto 0;
    max-width: 560px;
    padding: 28px 32px;
    border: 1px dashed var(--border);
    border-radius: 8px;

    h2 {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 600;
    }

    p {
      margin: 0 0 16px;
      color: var(--muted);
      font-size: 13px;
      line-height: 20px;
    }
  }

  &__steps {
    margin: 0;
    padding-left: 20px;
    font-size: 13px;
    line-height: 22px;
    color: var(--muted);

    strong {
      color: var(--body-text);
    }
  }

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  &__search {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 220px;
    max-width: 380px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    padding: 0 10px;

    &:focus-within {
      border-color: var(--link);
    }

    > .icon {
      color: var(--muted);
      font-size: 14px;
    }

    input {
      flex: 1;
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: var(--input-text);
      font-size: 13px;
      padding: 7px 8px;

      // Safari draws its own clear button on type=search, beside ours.
      &::-webkit-search-cancel-button {
        display: none;
      }
    }

    kbd {
      font-family: var(--font-family-mono, monospace);
      font-size: 10px;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 5px;
      line-height: 15px;
    }
  }

  &__search-clear {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 2px;

    &:hover {
      color: var(--body-text);
    }
  }

  &__matches {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--muted);

    strong {
      color: var(--body-text);
      font-variant-numeric: tabular-nums;
    }
  }

  &__foot {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin: 24px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
  }

  &__agents {
    display: inline-flex;
    align-items: center;
    gap: 5px;

    .icon {
      color: var(--success);
    }
  }
}
</style>
