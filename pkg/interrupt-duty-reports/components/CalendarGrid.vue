<script setup lang="ts">
// The reports, on the month they were written for.
//
// The square carries the number that matters - how many items were owed a move that day - and is
// tinted from it, which is a sequential scale across a grid and the one job a heatmap is properly
// for. The number is printed as well as encoded, so the colour is the second way of reading a
// square and never the only one.
//
// Days outside the month are drawn rather than blanked. A square that is empty because nothing
// ran has to look different from one that is empty because it belongs to another month, and
// that difference is the whole reason this is a calendar instead of a list.
import { computed } from 'vue';
import {
  actNowLevel, buildMonth, shiftMonth, WEEKDAYS,
} from '../lib/calendar';
import { statusStyle, whenLabel } from '../lib/format';
import type { ReportMeta } from '../types';

const props = defineProps<{
  reports: ReportMeta[];
  year: number;
  month: number;
  /** When a search is running, the reports it matched. Everything else is dimmed, not hidden. */
  matched?: Set<string> | null;
}>();

const emit = defineEmits<{
  (e: 'open', meta: ReportMeta): void;
  (e: 'month', value: { year: number; month: number }): void;
}>();

/** At most this many report chips in one square before the rest are counted instead. */
const MAX_CHIPS = 2;

const grid = computed(() => buildMonth(props.year, props.month, props.reports));

const isThisMonth = computed(() => {
  const now = new Date();

  return now.getUTCFullYear() === props.year && now.getUTCMonth() === props.month;
});

function dimmed(meta: ReportMeta): boolean {
  return !!props.matched && !props.matched.has(meta.id);
}

function chipTitle(meta: ReportMeta): string {
  const status = statusStyle(meta.status).label;
  const when = whenLabel(meta.startedAt);

  if (meta.status === 'complete') {
    return `${ meta.actNow || 0 } needing action · ${ status } · ${ when }`;
  }

  return `${ status }${ meta.error ? ` — ${ meta.error }` : '' } · ${ when }`;
}

/** The time of day, which is the only thing telling two reports on one date apart. */
function timeLabel(meta: ReportMeta): string {
  const at = new Date(meta.startedAt || '');

  if (Number.isNaN(at.getTime())) {
    return '';
  }

  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function go(by: number) {
  emit('month', shiftMonth(props.year, props.month, by));
}

function goToday() {
  const now = new Date();

  emit('month', { year: now.getUTCFullYear(), month: now.getUTCMonth() });
}
</script>

<template>
  <section class="cal" data-testid="idr-calendar">
    <header class="cal__head">
      <h2 class="cal__month">
        {{ grid.label }}
      </h2>
      <div class="cal__nav">
        <button type="button" aria-label="Previous month" data-testid="idr-cal-prev" @click="go(-1)">
          <i class="icon icon-chevron-left" />
        </button>
        <button
          type="button"
          class="cal__today"
          :disabled="isThisMonth"
          data-testid="idr-cal-today"
          @click="goToday"
        >
          Today
        </button>
        <button type="button" aria-label="Next month" data-testid="idr-cal-next" @click="go(1)">
          <i class="icon icon-chevron-right" />
        </button>
      </div>
    </header>

    <div class="cal__weekdays" aria-hidden="true">
      <span v-for="day in WEEKDAYS" :key="day">{{ day }}</span>
    </div>

    <div class="cal__grid">
      <template v-for="(week, w) in grid.weeks" :key="w">
        <div
          v-for="day in week"
          :key="day.date"
          class="cal__day"
          :class="{
            'is-outside': !day.inMonth,
            'is-today': day.isToday,
            'is-weekend': day.isWeekend,
            'has-reports': day.reports.length > 0,
          }"
          :data-level="day.reports.length ? actNowLevel(day.reports[0].actNow) : 0"
          :data-testid="`idr-day-${ day.date }`"
        >
          <span class="cal__number">{{ day.dayOfMonth }}</span>

          <button
            v-for="meta in day.reports.slice(0, MAX_CHIPS)"
            :key="meta.id"
            type="button"
            class="cal__report"
            :class="[`is-${ meta.status }`, { 'is-dimmed': dimmed(meta) }]"
            :title="chipTitle(meta)"
            :aria-label="`Open the report for ${ day.date }, ${ chipTitle(meta) }`"
            data-testid="idr-day-report"
            @click="emit('open', meta)"
          >
            <template v-if="meta.status === 'complete'">
              <span class="cal__count">{{ meta.actNow || 0 }}</span>
              <!--
                The time, and only when there are two reports on one day - that is the only
                thing telling them apart. On the usual one-report day it said "to act on" in
                every square on the page, which is what the legend says once.
              -->
              <span v-if="day.reports.length > 1" class="cal__chip-meta">{{ timeLabel(meta) }}</span>
            </template>
            <template v-else>
              <i
                class="icon"
                :class="meta.status === 'running' ? 'icon-spinner icon-spin' : meta.status === 'failed' ? 'icon-warning' : 'icon-close'"
              />
              <span class="cal__chip-meta">{{ statusStyle(meta.status).label }}</span>
            </template>
          </button>

          <span v-if="day.reports.length > MAX_CHIPS" class="cal__more">
            +{{ day.reports.length - MAX_CHIPS }} more
          </span>
        </div>
      </template>
    </div>

    <footer class="cal__legend">
      <span class="cal__legend-label">Needing action</span>
      <span class="cal__legend-scale">
        <i>0</i>
        <span v-for="level in [1, 2, 3, 4]" :key="level" :data-level="level" />
        <i>10+</i>
      </span>
      <span class="cal__legend-note">Click a day to open its report.</span>
    </footer>
  </section>
</template>

<style lang="scss" scoped>
.cal {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
  }

  &__month {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  &__nav {
    display: flex;
    align-items: center;
    gap: 4px;

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 28px;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--body-bg);
      color: var(--body-text);
      font-size: 12px;
      cursor: pointer;

      &:hover:not(:disabled) {
        border-color: var(--link);
        color: var(--link);
      }

      &:disabled {
        opacity: 0.45;
        cursor: default;
      }
    }
  }

  &__weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 6px;
    margin-bottom: 6px;

    span {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--muted);
      padding-left: 2px;
    }
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 6px;
  }

  &__day {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 76px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--body-bg);

    // The sequential scale: one hue, five steps, mixed into the surface so it works out to a
    // light tint on a light theme and a dark one on a dark theme without two sets of values.
    &[data-level='1'] { background: color-mix(in srgb, var(--error) 13%, var(--body-bg)); }
    &[data-level='2'] { background: color-mix(in srgb, var(--error) 23%, var(--body-bg)); }
    &[data-level='3'] { background: color-mix(in srgb, var(--error) 34%, var(--body-bg)); }
    &[data-level='4'] { background: color-mix(in srgb, var(--error) 46%, var(--body-bg)); }

    // A day from the neighbouring month is context, not content.
    &.is-outside {
      background: transparent;
      border-color: transparent;

      .cal__number {
        opacity: 0.35;
      }
    }

    &.is-weekend {
      border-style: dashed;

      &:not(.has-reports) {
        background: var(--nav-bg);
        opacity: 0.6;
      }

      .cal__number {
        font-weight: 400;
      }
    }

    &.is-today {
      border-color: var(--link);
      box-shadow: inset 0 0 0 1px var(--link);
    }
  }

  &__number {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  &__day.is-today &__number {
    color: var(--link);
  }

  &__report {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 5px;
    width: 100%;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--body-bg);
    color: var(--body-text);
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition: border-color 0.12s ease, transform 0.12s ease;

    &:hover,
    &:focus-visible {
      border-color: var(--link);
      transform: translateY(-1px);
    }

    // Dimmed rather than hidden while searching: a day that had a report still had one, and
    // removing it would make the month look emptier than it was.
    &.is-dimmed {
      opacity: 0.3;
    }

    &.is-failed {
      border-color: var(--error);
      color: var(--error);
    }

    &.is-running {
      border-color: var(--info);
      color: var(--info);
    }

    &.is-cancelled {
      border-color: var(--warning);
      color: var(--warning);
    }

    .icon {
      font-size: 11px;
    }
  }

  &__count {
    font-size: 16px;
    font-weight: 700;
    line-height: 20px;
  }

  &__chip-meta {
    font-size: 9px;
    letter-spacing: 0.02em;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__more {
    font-size: 9px;
    color: var(--muted);
    padding-left: 2px;
  }

  &__legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 12px;
    font-size: 11px;
    color: var(--muted);
  }

  &__legend-label {
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  &__legend-scale {
    display: inline-flex;
    align-items: center;
    gap: 3px;

    span {
      width: 16px;
      height: 11px;
      border-radius: 2px;
      border: 1px solid var(--border);

      &[data-level='1'] { background: color-mix(in srgb, var(--error) 13%, var(--body-bg)); }
      &[data-level='2'] { background: color-mix(in srgb, var(--error) 23%, var(--body-bg)); }
      &[data-level='3'] { background: color-mix(in srgb, var(--error) 34%, var(--body-bg)); }
      &[data-level='4'] { background: color-mix(in srgb, var(--error) 46%, var(--body-bg)); }
    }

    i {
      font-style: normal;
      font-variant-numeric: tabular-nums;
    }
  }

  &__legend-note {
    margin-left: auto;
  }
}

// Seven columns stop being squares long before a phone; below that the month becomes a column.
@media (max-width: 900px) {
  .cal__weekdays {
    display: none;
  }

  .cal__grid {
    grid-template-columns: 1fr;
  }

  .cal__day {
    min-height: 0;
    flex-direction: row;
    align-items: center;
    gap: 10px;

    &.is-outside {
      display: none;
    }
  }

  .cal__report {
    width: auto;
  }
}
</style>
