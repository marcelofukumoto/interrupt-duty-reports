<script setup lang="ts">
// One report, opened. What the markdown file used to be, read as a page instead of scrolled.
//
// Three things the flat version could not do, and this one is shaped around:
//
//   - filter by class. On a busy day this is thirty items, and the reader is almost always
//     after one subset of them - usually "what needs a move today". Reading past the rest to
//     find those is the work the report was supposed to save.
//   - see what is new. A ticket on the list for the first time is a new obligation; one on it
//     for the second day running is the queue not moving. Neither is visible when every item
//     looks the same, so the previous report is fetched and the difference marked.
//   - keep its bearings. The header and the filters stay put while the body scrolls, so the
//     counts and the way back to the top are never a scroll away.
//
// The payload is fetched here rather than handed in, because the list only ever holds
// summaries - a hundred rows of dates must not mean a hundred reports downloaded.
import { computed, onMounted, ref } from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import ItemCard from './ItemCard.vue';
import CopyButton from './CopyButton.vue';
import { getReport } from '../lib/store';
import { computeDelta, itemRef } from '../lib/delta';
import type { ReportDelta } from '../lib/delta';
import {
  ageLabel, classStyle, CLASS_ORDER, whenLabel,
} from '../lib/format';
import type {
  GitHubItem, ItemClass, JiraItem, QuestionItem, Report, ReportMeta,
} from '../types';

const props = defineProps<{
  meta: ReportMeta;
  /** The report before this one, for the difference between them. Absent for the first ever. */
  previousId?: string;
  previousDate?: string;
  /**
   * The slide-in's own configuration, declared so that it is consumed rather than inherited.
   *
   * SlideInPanelManager hands the component everything it was opened with, and an undeclared
   * prop falls through onto the root element as a real HTML attribute.
   */
  width?: string;
  /**
   * Removing this report, handed in by the page that owns the list.
   *
   * Delete lives here rather than on the calendar square because a square is a hundred pixels
   * wide with no room for a control and its confirmation, and because the moment somebody
   * actually wants a report gone is the moment they have just read it.
   */
  onDelete?: (meta: ReportMeta) => Promise<void> | void;
  /** Opening the conversation that wrote this report, while the agent pod still holds it. */
  onWatch?: (meta: ReportMeta) => void;
}>();

const report = ref<Report | null>(null);
const delta = ref<ReportDelta | null>(null);
const error = ref('');
const loading = ref(true);
const activeClass = ref<ItemClass | 'ALL'>('ALL');
const store = useStore();

const confirmingDelete = ref(false);
const deleting = ref(false);

/** A run that did not finish has no report to show, and says what happened instead. */
const unfinished = computed(() => (props.meta.status === 'complete' ? null : props.meta.status));

function close() {
  store.commit('slideInPanel/close');
}

async function remove() {
  if (!props.onDelete || deleting.value) {
    return;
  }

  deleting.value = true;

  try {
    await props.onDelete(props.meta);
    close();
  } catch (e: any) {
    error.value = e?.message || String(e);
    deleting.value = false;
    confirmingDelete.value = false;
  }
}

onMounted(async() => {
  if (unfinished.value) {
    loading.value = false;

    return;
  }

  try {
    const loaded = await getReport(props.meta.id);

    if (!loaded) {
      error.value = 'The report itself is missing — only its summary is stored. It was probably deleted, or the run never finished writing it.';
    } else {
      report.value = loaded;
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }

  // After the report and never blocking it: the difference is useful context, and a previous
  // report that has since been deleted is a reason to show no badges, not an error.
  if (report.value && props.previousId) {
    const previous = await getReport(props.previousId).catch(() => null);

    delta.value = computeDelta(report.value, previous, props.previousDate || '');
  }
});


const headline = computed(() => report.value?.reminder?.line || props.meta.headline || '');

const jiraGroups = computed<{ key: string; title: string; note: string; items: JiraItem[] }[]>(() => {
  const jira = report.value?.jira;

  if (!jira) {
    return [];
  }

  return [
    {
      key: 'new', title: 'Jira · New', note: 'Untriaged — we owe the first move.', items: jira.new || [],
    },
    {
      key: 'in_triage', title: 'Jira · In triage', note: 'Being triaged — we owe a decision.', items: jira.in_triage || [],
    },
    {
      key: 'waiting_reporter', title: 'Jira · Waiting for reporter', note: 'Every one is listed, even with nothing overdue.', items: jira.waiting_reporter || [],
    },
  ];
});

const issues = computed<GitHubItem[]>(() => report.value?.github?.issues || []);
const questions = computed<QuestionItem[]>(() => report.value?.github?.questions || []);

type AnyItem = JiraItem | GitHubItem | QuestionItem;

/** Questions carry no class of their own; the report treats answering one as owed work. */
function classOf(item: AnyItem): string {
  return (item as JiraItem).class || 'ACT_NOW';
}

function keep(item: AnyItem): boolean {
  return activeClass.value === 'ALL' || classOf(item) === activeClass.value;
}

/** The filter chips, each with how many items it would leave. */
const classCounts = computed(() => {
  const everything: AnyItem[] = [
    ...jiraGroups.value.flatMap((g) => g.items),
    ...issues.value,
    ...questions.value,
  ];
  const counts = new Map<string, number>();

  for (const item of everything) {
    const name = classOf(item);

    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return {
    total:   everything.length,
    classes: CLASS_ORDER
      .filter((name) => counts.get(name))
      .map((name) => ({ name, count: counts.get(name) || 0, style: classStyle(name) })),
  };
});

/** Every section, already filtered, so the nav counts and the body can never disagree. */
const sections = computed(() => [
  ...jiraGroups.value.map((group) => ({
    key: group.key, title: group.title, note: group.note, kind: 'jira' as const, items: group.items.filter(keep), total: group.items.length,
  })),
  {
    key: 'github', title: 'GitHub · Community issues', note: 'Opened in the last 30 days. Older issues belong to the backlog process.', kind: 'github' as const, items: issues.value.filter(keep), total: issues.value.length,
  },
  {
    key: 'questions', title: 'GitHub · Open questions', note: 'Quick wins — answering one closes the loop.', kind: 'question' as const, items: questions.value.filter(keep), total: questions.value.length,
  },
]);

const shown = computed(() => sections.value.reduce((n, s) => n + s.items.length, 0));

const tiles = computed(() => {
  const counts = report.value?.reminder?.counts || props.meta.counts;

  if (!counts) {
    return [];
  }

  return [
    { label: 'Jira · New', value: counts.jira_new },
    { label: 'Jira · In triage', value: counts.jira_in_triage },
    { label: 'Jira · Waiting', value: counts.jira_waiting_reporter },
    { label: 'GitHub · New', value: counts.github_new },
    { label: 'Questions', value: counts.github_questions },
  ];
});

function isFresh(item: AnyItem): boolean {
  return !!delta.value?.fresh.has(itemRef(item));
}

function jiraChips(item: JiraItem) {
  return [
    { label: 'Priority', value: item.priority || '' },
    { label: 'Age', value: ageLabel(item.age_days) },
    { label: 'Assignee', value: item.assignee || 'unassigned' },
  ];
}

function issueChips(item: GitHubItem) {
  return [
    { label: 'Kind', value: item.kind || '' },
    { label: 'Age', value: ageLabel(item.age_days) },
    { label: 'Idle', value: ageLabel(item.idle_days) },
    { label: 'Comments', value: item.comments_count === null || item.comments_count === undefined ? '' : String(item.comments_count) },
  ];
}

function questionChips(item: QuestionItem) {
  return [
    { label: 'Age', value: ageLabel(item.age_days) },
    { label: 'Idle', value: ageLabel(item.idle_days) },
  ];
}

function chipsFor(section: { kind: string }, item: AnyItem) {
  if (section.kind === 'jira') {
    return jiraChips(item as JiraItem);
  }

  return section.kind === 'github' ? issueChips(item as GitHubItem) : questionChips(item as QuestionItem);
}

/**
 * The whole report as text, for pasting somewhere that is not this page.
 *
 * The reports used to be markdown files read in pull requests and in chat, so the one thing the
 * move to a UI must not take away is the ability to hand somebody the report. It follows the
 * filter: what you copy is what you are looking at.
 */
const asText = computed(() => {
  const r = report.value;

  if (!r) {
    return '';
  }

  const lines: string[] = [`Daily Interrupt Duty Report — ${ props.meta.reportDate }`, ''];

  if (r.reminder?.line) {
    lines.push(r.reminder.line, '');
  }

  if (activeClass.value !== 'ALL') {
    lines.push(`(filtered to ${ classStyle(activeClass.value).label })`, '');
  }

  if (activeClass.value === 'ALL' && r.top3?.length) {
    lines.push('Top 3:');
    r.top3.forEach((t, i) => lines.push(`  ${ i + 1 }. ${ t.ref } — ${ t.title }${ t.why ? ` (${ t.why })` : '' }`));
    lines.push('');
  }

  for (const section of sections.value) {
    if (!section.items.length) {
      continue;
    }

    lines.push(`## ${ section.title }`);

    for (const item of section.items) {
      const step = (item as JiraItem).next_step;

      lines.push(`- ${ itemRef(item) } — ${ item.title }${ isFresh(item) ? '  [new]' : '' }`);
      lines.push(`  Next step: ${ step?.verb } — ${ step?.explanation }`);
      if ((item as JiraItem).suggested_comment) {
        lines.push(`  Suggested comment: ${ (item as JiraItem).suggested_comment }`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
});
</script>

<template>
  <div class="panel">
    <div v-if="loading" class="panel__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Opening the report…</span>
    </div>

    <section v-else-if="unfinished" class="panel__unfinished" data-testid="idr-unfinished">
      <h2>
        {{ meta.reportDate }} —
        {{ unfinished === 'running' ? 'still being generated' : unfinished === 'failed' ? 'this run failed' : 'this run was stopped' }}
      </h2>
      <p v-if="meta.error" class="panel__unfinished-why">
        {{ meta.error }}
      </p>
      <p v-else-if="unfinished === 'running'">
        The agent is working on it. The page shows each step as it happens.
      </p>
      <p v-else>
        No reason was recorded.
      </p>
      <div class="panel__unfinished-actions">
        <button type="button" class="btn role-secondary" data-testid="idr-panel-close" @click="close">
          Close
        </button>
        <button
          v-if="onDelete && !confirmingDelete"
          type="button"
          class="btn role-secondary"
          data-testid="idr-panel-delete"
          @click="confirmingDelete = true"
        >
          <i class="icon icon-delete" />
          Delete this report
        </button>
        <template v-else-if="onDelete">
          <button type="button" class="btn role-secondary" :disabled="deleting" @click="confirmingDelete = false">
            Cancel
          </button>
          <button
            type="button"
            class="btn bg-error"
            :disabled="deleting"
            data-testid="idr-panel-delete-confirm"
            @click="remove"
          >
            {{ deleting ? 'Deleting…' : 'Delete report' }}
          </button>
        </template>
      </div>
    </section>

    <Banner v-else-if="error" color="error">
      {{ error }}
    </Banner>

    <template v-else-if="report">
      <!-- Sticky, so the counts and the filters are never a scroll away from the item you are reading. -->
      <div class="panel__intro">
        <header class="panel__head" data-testid="idr-report-panel">
          <div class="panel__identity">
            <p class="panel__eyebrow">
              Daily interrupt duty
            </p>
            <!--
              The summary's date, not the payload's. They agree - publish.sh copies one into the
              other - but the summary's is the one the calendar placed this square on, and a
              panel that disagrees with the square you just clicked is worse than either being
              wrong on its own.
            -->
            <h2 class="panel__date">
              {{ meta.reportDate }}
            </h2>
            <p class="panel__generated">
              Generated {{ whenLabel(meta.finishedAt || meta.startedAt) }}
              <template v-if="meta.startedBy"> · by {{ meta.startedBy }}</template>
            </p>
          </div>
          <div class="panel__tools">
            <button
              v-if="onWatch && meta.session"
              type="button"
              class="panel__watch"
              title="Open the conversation that wrote this report"
              data-testid="idr-panel-watch"
              @click="onWatch(meta)"
            >
              <i class="icon icon-terminal" />
              Agent session
            </button>
            <CopyButton :text="asText" :label="activeClass === 'ALL' ? 'Copy whole report' : 'Copy what is shown'" />
            <button
              type="button"
              class="panel__close"
              title="Close"
              aria-label="Close the report"
              data-testid="idr-panel-close"
              @click="close"
            >
              <i class="icon icon-close" />
            </button>
            <template v-if="onDelete">
              <template v-if="confirmingDelete">
                <button type="button" class="btn btn-sm role-secondary" :disabled="deleting" @click="confirmingDelete = false">
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn-sm bg-error"
                  :disabled="deleting"
                  data-testid="idr-panel-delete-confirm"
                  @click="remove"
                >
                  {{ deleting ? 'Deleting…' : 'Delete report' }}
                </button>
              </template>
              <button
                v-else
                type="button"
                class="panel__delete"
                title="Delete this report"
                data-testid="idr-panel-delete"
                @click="confirmingDelete = true"
              >
                <i class="icon icon-delete" />
              </button>
            </template>
          </div>
        </header>

        <p v-if="headline" class="panel__headline">
          {{ headline }}
        </p>

        <p v-if="delta" class="panel__delta" data-testid="idr-delta">
          <span v-if="delta.fresh.size" class="panel__delta-new">
            <strong>{{ delta.fresh.size }}</strong> new since {{ delta.previousDate }}
          </span>
          <span v-else>Nothing new since {{ delta.previousDate }}</span>
          <span v-if="delta.carried.size">· <strong>{{ delta.carried.size }}</strong> carried over</span>
          <span v-if="delta.clearedCount">· <strong>{{ delta.clearedCount }}</strong> cleared</span>
        </p>

        <div class="panel__filters" role="group" aria-label="Filter items by class">
          <button
            type="button"
            class="panel__chip"
            :class="{ 'is-active': activeClass === 'ALL' }"
            data-testid="idr-filter-all"
            @click="activeClass = 'ALL'"
          >
            All <span>{{ classCounts.total }}</span>
          </button>
          <button
            v-for="entry in classCounts.classes"
            :key="entry.name"
            type="button"
            class="panel__chip"
            :class="{ 'is-active': activeClass === entry.name }"
            :style="{ '--chip-color': `var(${ entry.style.colorVar })` }"
            :title="entry.style.hint"
            :data-testid="`idr-filter-${ entry.name }`"
            @click="activeClass = activeClass === entry.name ? 'ALL' : entry.name"
          >
            <i class="icon" :class="entry.style.icon" />
            {{ entry.style.label }} <span>{{ entry.count }}</span>
          </button>
        </div>
</div>

      <div class="panel__body">
        <ul v-if="tiles.length && activeClass === 'ALL'" class="panel__tiles">
          <li v-for="tile in tiles" :key="tile.label" :class="{ 'is-zero': !tile.value }">
            <span class="panel__tile-value">{{ tile.value }}</span>
            <span class="panel__tile-label">{{ tile.label }}</span>
          </li>
        </ul>

        <section v-if="activeClass === 'ALL' && report.top3 && report.top3.length" class="panel__top">
          <h3 class="panel__section-title">
            <i class="icon icon-star" />
            Act on these first
          </h3>
          <ol class="panel__top-list">
            <li
              v-for="(top, index) in report.top3"
              :key="top.ref"
              :style="{ '--top-color': `var(${ classStyle(top.class).colorVar })` }"
            >
              <span class="panel__top-rank">{{ index + 1 }}</span>
              <div class="panel__top-body">
                <a :href="top.url" target="_blank" rel="noopener noreferrer" class="panel__top-ref">{{ top.ref }}</a>
                <span v-if="top.meta" class="panel__top-meta">{{ top.meta }}</span>
                <p class="panel__top-title">
                  {{ top.title }}
                </p>
                <p v-if="top.why" class="panel__top-why">
                  {{ top.why }}
                </p>
              </div>
            </li>
          </ol>
        </section>

        <p v-if="!shown" class="panel__empty">
          Nothing in this report is
          <strong>{{ activeClass === 'ALL' ? 'listed' : classStyle(activeClass).label.toLowerCase() }}</strong>.
          <button type="button" class="panel__link" @click="activeClass = 'ALL'">
            Show everything
          </button>
        </p>

        <section
          v-for="section in sections"
          v-show="section.items.length"
          :key="section.key"
          class="panel__section"
          :data-section="section.key"
        >
          <h3 class="panel__section-title">
            {{ section.title }}
            <span class="panel__count">
              {{ section.items.length }}<template v-if="section.items.length !== section.total"> of {{ section.total }}</template>
            </span>
          </h3>
          <p class="panel__section-note">
            {{ section.note }}
          </p>
          <ItemCard
            v-for="item in section.items"
            :key="itemRef(item)"
            :reference="itemRef(item)"
            :url="item.url"
            :title="item.title"
            :item-class="section.kind === 'question' ? 'ACT_NOW' : (item as JiraItem).class"
            :chips="chipsFor(section, item)"
            :last-activity="section.kind === 'jira' ? (item as JiraItem).last_activity : null"
            :linked-prs="section.kind === 'github' ? (item as GitHubItem).linked_prs : undefined"
            :next-step="(item as JiraItem).next_step"
            :suggested-comment="(item as JiraItem).suggested_comment"
            :quick-action="section.kind === 'jira' ? (item as JiraItem).quick_action : null"
            :is-new="isFresh(item)"
            :new-since="delta?.previousDate"
          />
        </section>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.panel {
  padding: 0 4px 48px;

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 40px 0;
    color: var(--muted);
  }

  &__unfinished {
    padding: 28px 4px;

    h2 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 600;
    }

    p {
      margin: 0 0 18px;
      max-width: 62ch;
      color: var(--muted);
      font-size: 13px;
      line-height: 20px;
    }
  }

  &__unfinished-why {
    color: var(--error) !important;
  }

  &__unfinished-actions {
    display: flex;
    gap: 10px;
  }

  // Deliberately not sticky. A header that shrinks as you scroll has to be measured by anything
  // that scrolls to a position under it, and a measurement that changes is a measurement that
  // goes wrong - it put section titles behind the header twice. It scrolls away like the rest of
  // the page, and the filters are a scroll up rather than a permanent strip.
  &__intro {
    padding: 2px 0 12px;
    border-bottom: 1px solid var(--border);
  }

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
  }

  &__eyebrow {
    margin: 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__date {
    margin: 1px 0 3px;
    font-size: 24px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__tools {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  &__watch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--body-bg);
    color: var(--body-text);
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;

    &:hover {
      border-color: var(--link);
      color: var(--link);
    }
  }

  &__delete,
  &__close {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 5px;
    border-radius: 4px;

    &:hover {
      background: var(--nav-bg);
    }
  }

  &__delete:hover {
    color: var(--error);
  }

  &__close:hover {
    color: var(--body-text);
  }

  &__generated {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }

  &__headline {
    margin: 10px 0 0;
    font-size: 13px;
    line-height: 19px;
  }

  &__delta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--muted);

    strong {
      color: var(--body-text);
      font-variant-numeric: tabular-nums;
    }
  }

  &__delta-new strong {
    color: var(--warning);
  }

  &__filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  &__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 13px;
    border: 1px solid var(--border);
    background: var(--body-bg);
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease, background-color 0.12s ease;

    span {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--body-text);
    }

    .icon {
      font-size: 12px;
      color: var(--chip-color, var(--muted));
    }

    &:hover {
      border-color: var(--chip-color, var(--link));
      color: var(--body-text);
    }

    // The active chip is filled as well as coloured, so which filter is on does not rest on a
    // border tint alone.
    &.is-active {
      background: var(--chip-color, var(--link));
      border-color: var(--chip-color, var(--link));
      color: var(--body-bg);

      span,
      .icon {
        color: var(--body-bg);
      }
    }
  }

  &__body {
    padding-top: 18px;
  }

  &__tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: 10px;
    margin: 0 0 8px;
    padding: 0;
    list-style: none;

    li {
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--nav-bg);

      &.is-zero {
        opacity: 0.55;
      }
    }
  }

  &__tile-value {
    display: block;
    font-size: 24px;
    font-weight: 600;
    line-height: 28px;
  }

  &__tile-label {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__section {
    margin-top: 28px;
  }

  &__top {
    margin-top: 24px;
  }

  &__section-title {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 600;
  }

  &__count {
    padding: 1px 9px;
    border-radius: 11px;
    background: var(--nav-bg);
    border: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__section-note {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--muted);
  }

  &__empty {
    margin: 20px 0;
    padding: 24px;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
    text-align: center;

    strong {
      color: var(--body-text);
    }
  }

  &__link {
    border: none;
    background: transparent;
    color: var(--link);
    font-size: 13px;
    cursor: pointer;
    padding: 0 0 0 4px;

    &:hover {
      text-decoration: underline;
    }
  }

  &__top-list {
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      display: flex;
      gap: 14px;
      padding: 14px 16px;
      margin-bottom: 10px;
      border: 1px solid var(--border);
      border-left: 4px solid var(--top-color);
      border-radius: 6px;
      background: var(--body-bg);
    }
  }

  &__top-rank {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--top-color);
    color: var(--body-bg);
    font-weight: 700;
    font-size: 13px;
  }

  &__top-body {
    min-width: 0;
  }

  &__top-ref {
    font-family: var(--font-family-mono, monospace);
    font-size: 13px;
    font-weight: 600;
    margin-right: 10px;
  }

  &__top-meta {
    font-size: 11px;
    color: var(--muted);
  }

  &__top-title {
    margin: 4px 0 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 21px;
  }

  &__top-why {
    margin: 5px 0 0;
    font-size: 13px;
    line-height: 19px;
    color: var(--muted);
  }
}
</style>
