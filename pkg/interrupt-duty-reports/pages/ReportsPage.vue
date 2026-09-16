<script setup lang="ts">
// The whole extension, as a page: three buttons and the list of reports.
//
// Generate and Stop sit in the header, because there is only ever one run in flight and it
// belongs to the page rather than to any row. Delete is per report, because that is what
// deleting a report means.
//
// Nothing is polled when nothing is happening. A run in flight is watched every few seconds -
// the agent publishes into the cluster and the row follows it - and a settled list is refreshed
// only when the page is opened or somebody asks.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import CredentialsDialog from '../components/CredentialsDialog.vue';
import ReportPanel from '../components/ReportPanel.vue';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import type { AgentsStatus } from '../lib/agents';
import { deleteReport, listReports, MAX_REPORTS, pruneToCap, setStatus } from '../lib/store';
import { runActivity, startRun, stopRun } from '../lib/run';
import {
  countChips, elapsedLabel, isStale, statusStyle, whenLabel,
} from '../lib/format';
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
const activity = ref('');
const deleting = ref<string | null>(null);
const confirmingDelete = ref<string | null>(null);
/** The tab's memory of the two tokens, so a second report in one sitting is one click. */
const remembered = ref({ jiraPat: '', ghToken: '' });

const POLL_RUNNING_MS = 4000;
const POLL_IDLE_MS = 45000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

const activeRun = computed(() => reports.value.find((r) => r.status === 'running') || null);
const canGenerate = computed(() => agents.value.state === 'ready' && !activeRun.value && !starting.value);

async function refresh() {
  try {
    reports.value = await listReports();
    error.value = '';
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
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
        activity.value = '';
        await refresh();
      } else {
        activity.value = await runActivity(run).catch(() => '');
      }
    } else {
      activity.value = '';
    }

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

onMounted(async() => {
  // The agents bundle may not have installed its API yet: two extensions on one page load in
  // whatever order Rancher loaded them.
  await whenAgentsReady();
  agents.value = await agentsStatus();

  await refresh();
  loading.value = false;

  // Anything over the cap from before is cleared once, quietly, on the way in.
  pruneToCap(MAX_REPORTS).then((pruned) => (pruned ? refresh() : undefined)).catch(() => undefined);

  schedule();
});

onBeforeUnmount(() => {
  stopped = true;
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
    await startRun(credentials, store.getters['auth/principal']?.loginName || undefined);
    askingForTokens.value = false;
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
    activity.value = '';
    await refresh();
    restartPolling();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    stopping.value = false;
  }
}

async function remove(meta: ReportMeta) {
  deleting.value = meta.id;

  try {
    // A report still running is a conversation still running: ending it first means deleting a
    // row cannot leave a claude in the pod working on something nothing will ever read.
    if (meta.status === 'running') {
      await stopRun(meta).catch(() => undefined);
    }

    await deleteReport(meta.id);
    confirmingDelete.value = null;
    await refresh();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    deleting.value = null;
  }
}

function open(meta: ReportMeta) {
  if (meta.status !== 'complete') {
    return;
  }

  store.commit('slideInPanel/open', {
    component:      ReportPanel,
    componentProps: {
      title: `Daily report · ${ meta.reportDate }`,
      width: 'wide',
      meta,
    },
  });
}
</script>

<template>
  <div class="idr">
    <header class="idr__head">
      <div>
        <h1 class="idr__title">
          Interrupt duty reports
        </h1>
        <p class="idr__lede">
          The day's Jira escalations and <code>rancher/dashboard</code> community issues, each
          with a recommended next step and a comment you can send. Generated by the agent in
          this cluster and kept here — the newest {{ MAX_REPORTS }} are retained.
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
          Generate daily report
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

    <Banner
      v-if="agents.state !== 'ready' && agents.state !== 'checking'"
      :color="agents.state === 'no-pod' ? 'warning' : 'error'"
      data-testid="idr-agents-banner"
    >
      <strong>Agents is not ready.</strong> {{ agents.detail }}
    </Banner>

    <Banner v-else-if="agents.state === 'ready'" color="success" class="idr__ready" data-testid="idr-agents-banner">
      <i class="icon icon-checkmark" />
      <span>{{ agents.detail }}</span>
    </Banner>

    <Banner v-if="error" color="error">
      {{ error }}
    </Banner>

    <div v-if="loading" class="idr__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Loading reports…</span>
    </div>

    <p v-else-if="!reports.length" class="idr__empty">
      No reports yet. Generate one — it takes a few minutes, and you can watch it work below.
    </p>

    <ul v-else class="idr__list">
      <li
        v-for="report in reports"
        :key="report.id"
        class="idr__row"
        :class="{ 'is-open': report.status === 'complete', 'is-running': report.status === 'running' }"
        :style="{ '--row-color': `var(${ statusStyle(report.status).colorVar })` }"
        data-testid="idr-report-row"
      >
        <button
          type="button"
          class="idr__open"
          :disabled="report.status !== 'complete'"
          @click="open(report)"
        >
          <div class="idr__row-main">
            <div class="idr__row-date">
              <span class="idr__date">{{ report.reportDate }}</span>
              <span class="idr__status">
                <i
                  v-if="report.status === 'running'"
                  class="icon icon-spinner icon-spin"
                />
                {{ statusStyle(report.status).label }}
              </span>
            </div>

            <p v-if="report.headline" class="idr__headline">
              {{ report.headline }}
            </p>
            <p v-else-if="report.status === 'running'" class="idr__headline idr__headline--muted">
              Gathering the day's Jira and GitHub state, then writing the report…
            </p>
            <p v-else-if="report.error" class="idr__headline idr__headline--error">
              {{ report.error }}
            </p>

            <ul v-if="report.counts" class="idr__chips">
              <li v-if="report.actNow" class="is-act-now">
                <strong>{{ report.actNow }}</strong> act now
              </li>
              <li v-for="chip in countChips(report)" :key="chip.label" :class="{ 'is-zero': !chip.value }">
                <strong>{{ chip.value }}</strong> {{ chip.label.toLowerCase() }}
              </li>
            </ul>

            <ul v-if="report.top3 && report.top3.length" class="idr__top">
              <li v-for="top in report.top3" :key="top.ref">
                {{ top.ref }}
              </li>
            </ul>

            <pre v-if="report.status === 'running' && activity && activeRun && activeRun.id === report.id" class="idr__activity">{{ activity }}</pre>
          </div>

          <div class="idr__row-meta">
            <span>{{ whenLabel(report.startedAt) }}</span>
            <span class="idr__elapsed">{{ elapsedLabel(report) }}</span>
            <span v-if="report.startedBy" class="idr__by">{{ report.startedBy }}</span>
          </div>
        </button>

        <div class="idr__row-side">
          <i v-if="report.status === 'complete'" class="icon icon-chevron-right idr__chevron" />

          <template v-if="confirmingDelete === report.id">
            <button
              type="button"
              class="btn btn-sm role-secondary"
              :disabled="deleting === report.id"
              @click.stop="confirmingDelete = null"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-sm bg-error"
              :disabled="deleting === report.id"
              data-testid="idr-delete-confirm"
              @click.stop="remove(report)"
            >
              {{ deleting === report.id ? 'Deleting…' : 'Delete' }}
            </button>
          </template>
          <button
            v-else
            type="button"
            class="idr__delete"
            title="Delete this report"
            data-testid="idr-delete"
            @click.stop="confirmingDelete = report.id"
          >
            <i class="icon icon-delete" />
          </button>
        </div>
      </li>
    </ul>

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
.idr {
  padding: 20px;

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }

  &__title {
    margin: 0 0 6px;
    font-size: 24px;
    font-weight: 600;
  }

  &__lede {
    margin: 0;
    max-width: 62ch;
    color: var(--muted);
    font-size: 13px;
    line-height: 19px;
  }

  &__actions {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  &__ready {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 40px 0;
    color: var(--muted);
  }

  &__empty {
    margin: 24px 0 0;
    padding: 28px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    text-align: center;
    color: var(--muted);
  }

  &__list {
    margin: 18px 0 0;
    padding: 0;
    list-style: none;
  }

  &__row {
    display: flex;
    align-items: stretch;
    gap: 6px;
    margin-bottom: 10px;
    border: 1px solid var(--border);
    border-left: 4px solid var(--row-color);
    border-radius: 7px;
    background: var(--body-bg);
    overflow: hidden;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;

    &.is-open:hover {
      border-color: var(--link);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);

      .idr__chevron {
        color: var(--link);
        transform: translateX(3px);
      }
    }

    // A run in flight reads as alive without moving anything a person is trying to click.
    &.is-running {
      animation: idr-pulse 2.4s ease-in-out infinite;
    }
  }

  &__open {
    flex: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    min-width: 0;
    padding: 14px 8px 14px 16px;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;

    &:disabled {
      cursor: default;
    }
  }

  &__row-main {
    min-width: 0;
    flex: 1;
  }

  &__row-date {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  &__date {
    font-size: 17px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--row-color);
  }

  &__headline {
    margin: 5px 0 0;
    font-size: 13px;
    line-height: 19px;

    &--muted {
      color: var(--muted);
    }

    &--error {
      color: var(--error);
    }
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 9px 0 0;
    padding: 0;
    list-style: none;

    li {
      padding: 2px 9px;
      border-radius: 4px;
      background: var(--nav-bg);
      font-size: 11px;
      color: var(--muted);

      strong {
        color: var(--body-text);
        font-variant-numeric: tabular-nums;
      }

      &.is-zero {
        opacity: 0.5;
      }

      &.is-act-now {
        background: var(--error);
        color: var(--body-bg);

        strong {
          color: var(--body-bg);
        }
      }
    }
  }

  &__top {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;

    li {
      font-family: var(--font-family-mono, monospace);
      font-size: 11px;
      color: var(--muted);

      &::before {
        content: '★ ';
      }
    }
  }

  &__activity {
    margin: 10px 0 0;
    padding: 8px 10px;
    max-height: 62px;
    overflow: hidden;
    border-radius: 4px;
    background: var(--nav-bg);
    color: var(--muted);
    font-family: var(--font-family-mono, monospace);
    font-size: 11px;
    line-height: 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  &__row-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  &__elapsed,
  &__by {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }

  &__row-side {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px 0 4px;
    flex-shrink: 0;
  }

  &__chevron {
    color: var(--muted);
    transition: transform 0.15s ease, color 0.15s ease;
  }

  &__delete {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 6px;
    border-radius: 4px;

    &:hover {
      color: var(--error);
      background: var(--nav-bg);
    }
  }
}

@keyframes idr-pulse {
  0%, 100% { border-left-color: var(--row-color); }
  50% { border-left-color: var(--border); }
}
</style>
