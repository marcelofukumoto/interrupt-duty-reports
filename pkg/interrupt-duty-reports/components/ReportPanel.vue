<script setup lang="ts">
// One report, opened. What the markdown file used to be, read as a page instead of scrolled.
//
// The panel fetches its own payload rather than being handed one, because the list only ever
// holds summaries - a hundred rows of dates must not mean a hundred reports downloaded. It is
// opened wide (73% of the viewport) since every item carries a paragraph of explanation and a
// draft comment, and a third of a screen turns each of those into a column of single words.
import { computed, onMounted, ref } from 'vue';
import { Banner } from '@components/Banner';
import ItemCard from './ItemCard.vue';
import CopyButton from './CopyButton.vue';
import { getReport } from '../lib/store';
import { ageLabel, classStyle, whenLabel } from '../lib/format';
import type { GitHubItem, JiraItem, QuestionItem, Report, ReportMeta } from '../types';

const props = defineProps<{
  meta: ReportMeta;
  /**
   * The slide-in's own configuration, declared so that it is consumed rather than inherited.
   *
   * SlideInPanelManager hands the component everything it was opened with, and an undeclared
   * prop falls through onto the root element - which put a literal `title` attribute on this
   * div and gave the whole panel a browser tooltip on hover.
   */
  title?: string;
  width?: string;
}>();

const report = ref<Report | null>(null);
const error = ref('');
const loading = ref(true);

onMounted(async() => {
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
});

/** The four counts as tiles, so the shape of the day is read before anything is scrolled. */
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

const headline = computed(() => report.value?.reminder?.line || props.meta.headline || '');

const jiraGroups = computed<{ key: string; title: string; note: string; items: JiraItem[] }[]>(() => {
  const jira = report.value?.jira;

  if (!jira) {
    return [];
  }

  return [
    {
      key: 'new', title: 'New', note: 'Untriaged — we owe the first move.', items: jira.new || [],
    },
    {
      key: 'in_triage', title: 'In triage', note: 'Being triaged — we owe a decision.', items: jira.in_triage || [],
    },
    {
      key: 'waiting_reporter', title: 'Waiting for reporter', note: 'Every one is listed, even with nothing overdue.', items: jira.waiting_reporter || [],
    },
  ];
});

const issues = computed<GitHubItem[]>(() => report.value?.github?.issues || []);
const questions = computed<QuestionItem[]>(() => report.value?.github?.questions || []);

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

/**
 * The whole report as text, for pasting somewhere that is not this page.
 *
 * The reports used to be markdown files and were read in pull requests and in chat, so the one
 * thing the move to a UI must not take away is the ability to hand somebody the report.
 */
const asText = computed(() => {
  const r = report.value;

  if (!r) {
    return '';
  }

  const lines: string[] = [`Daily Interrupt Duty Report — ${ r.report_date }`, ''];

  if (r.reminder?.line) {
    lines.push(r.reminder.line, '');
  }

  if (r.top3?.length) {
    lines.push('Top 3:');
    r.top3.forEach((t, i) => lines.push(`  ${ i + 1 }. ${ t.ref } — ${ t.title }${ t.why ? ` (${ t.why })` : '' }`));
    lines.push('');
  }

  const section = (title: string, items: { ref: string; title: string; next: string; comment?: string | null }[]) => {
    if (!items.length) {
      return;
    }
    lines.push(`## ${ title }`);
    for (const item of items) {
      lines.push(`- ${ item.ref } — ${ item.title }`);
      lines.push(`  Next step: ${ item.next }`);
      if (item.comment) {
        lines.push(`  Suggested comment: ${ item.comment }`);
      }
    }
    lines.push('');
  };

  for (const group of jiraGroups.value) {
    section(`Jira — ${ group.title }`, group.items.map((i) => ({
      ref: i.key, title: i.title, next: `${ i.next_step?.verb } — ${ i.next_step?.explanation }`, comment: i.suggested_comment,
    })));
  }

  section('GitHub — Community issues', issues.value.map((i) => ({
    ref: `#${ i.number }`, title: i.title, next: `${ i.next_step?.verb } — ${ i.next_step?.explanation }`, comment: i.suggested_comment,
  })));

  section('GitHub — Open questions', questions.value.map((i) => ({
    ref: `#${ i.number }`, title: i.title, next: `${ i.next_step?.verb } — ${ i.next_step?.explanation }`, comment: i.suggested_comment,
  })));

  return lines.join('\n');
});
</script>

<template>
  <div class="panel">
    <div v-if="loading" class="panel__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Opening the report…</span>
    </div>

    <Banner v-else-if="error" color="error">
      {{ error }}
    </Banner>

    <template v-else-if="report">
      <header class="panel__head" data-testid="idr-report-panel">
        <div>
          <p class="panel__eyebrow">
            Daily interrupt duty
          </p>
          <h2 class="panel__date">
            {{ report.report_date }}
          </h2>
          <p v-if="headline" class="panel__headline">
            {{ headline }}
          </p>
          <p class="panel__generated">
            Generated {{ whenLabel(meta.finishedAt || meta.startedAt) }}
            <template v-if="meta.startedBy"> · by {{ meta.startedBy }}</template>
          </p>
        </div>
        <CopyButton :text="asText" label="Copy whole report" />
      </header>

      <ul v-if="tiles.length" class="panel__tiles">
        <li v-for="tile in tiles" :key="tile.label" :class="{ 'is-zero': !tile.value }">
          <span class="panel__tile-value">{{ tile.value }}</span>
          <span class="panel__tile-label">{{ tile.label }}</span>
        </li>
      </ul>

      <section v-if="report.top3 && report.top3.length" class="panel__top">
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

      <section v-for="group in jiraGroups" :key="group.key" class="panel__section">
        <h3 class="panel__section-title">
          Jira · {{ group.title }}
          <span class="panel__count">{{ group.items.length }}</span>
        </h3>
        <p class="panel__section-note">
          {{ group.note }}
        </p>
        <p v-if="!group.items.length" class="panel__empty">
          Nothing in this queue today.
        </p>
        <ItemCard
          v-for="item in group.items"
          :key="item.key"
          :reference="item.key"
          :url="item.url"
          :title="item.title"
          :item-class="item.class"
          :chips="jiraChips(item)"
          :last-activity="item.last_activity"
          :next-step="item.next_step"
          :suggested-comment="item.suggested_comment"
          :quick-action="item.quick_action"
        />
      </section>

      <section class="panel__section">
        <h3 class="panel__section-title">
          GitHub · Community issues
          <span class="panel__count">{{ issues.length }}</span>
        </h3>
        <p class="panel__section-note">
          Opened in the last 30 days. Older issues belong to the backlog process.
        </p>
        <p v-if="!issues.length" class="panel__empty">
          No new community issues in the window.
        </p>
        <ItemCard
          v-for="item in issues"
          :key="item.number"
          :reference="`#${ item.number }`"
          :url="item.url"
          :title="item.title"
          :item-class="item.class"
          :chips="issueChips(item)"
          :linked-prs="item.linked_prs"
          :next-step="item.next_step"
          :suggested-comment="item.suggested_comment"
        />
      </section>

      <section class="panel__section">
        <h3 class="panel__section-title">
          GitHub · Open questions
          <span class="panel__count">{{ questions.length }}</span>
        </h3>
        <p class="panel__section-note">
          Quick wins — answering one closes the loop.
        </p>
        <p v-if="!questions.length" class="panel__empty">
          No open questions in the window.
        </p>
        <ItemCard
          v-for="item in questions"
          :key="item.number"
          :reference="`#${ item.number }`"
          :url="item.url"
          :title="item.title"
          item-class="ACT_NOW"
          :chips="questionChips(item)"
          :next-step="item.next_step"
          :suggested-comment="item.suggested_comment"
        />
      </section>
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

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border);
  }

  &__eyebrow {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__date {
    margin: 2px 0 6px;
    font-size: 26px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__headline {
    margin: 0 0 4px;
    font-size: 13px;
    line-height: 19px;
  }

  &__generated {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }

  &__tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: 10px;
    margin: 18px 0 8px;
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
    font-size: 26px;
    font-weight: 600;
    line-height: 30px;
    font-variant-numeric: tabular-nums;
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
    margin-top: 30px;
  }

  &__top {
    margin-top: 26px;
  }

  &__section-title {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }

  &__count {
    padding: 1px 9px;
    border-radius: 11px;
    background: var(--nav-bg);
    border: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__section-note {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--muted);
  }

  &__empty {
    margin: 0 0 12px;
    padding: 14px 16px;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
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
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--top-color);
    color: var(--body-bg);
    font-weight: 700;
    font-size: 14px;
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
