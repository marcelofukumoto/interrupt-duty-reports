<script setup lang="ts">
// How much has been landing on us, over the last dozen reports.
//
// A stat tile rather than a chart: there is one number that matters today - how many items are
// owed a move - and the history is context for it, not the subject. So the value leads, the
// change since the previous report sits beside it, and the sparkline is the smallest thing that
// answers "is this getting worse".
//
// The line is drawn in the de-emphasis ink and only the current point takes the status colour,
// which keeps that colour meaning "this is what is owed now" rather than decorating the whole
// series. The current point is also twice the size of the others, so it is identifiable without
// relying on colour at all.
import { computed, ref } from 'vue';

const props = defineProps<{
  points: { date: string; value: number }[];
}>();

const WIDTH = 168;
const HEIGHT = 40;
const PAD = 4;

const hovered = ref<number | null>(null);

const latest = computed(() => props.points[props.points.length - 1] || null);
const previous = computed(() => (props.points.length > 1 ? props.points[props.points.length - 2] : null));

const delta = computed(() => {
  if (!latest.value || !previous.value) {
    return null;
  }

  return latest.value.value - previous.value.value;
});

/**
 * The plotted points.
 *
 * The scale starts at zero rather than at the minimum: these are counts of work owed, and a
 * floor at the smallest value would draw a quiet week as a dramatic climb. A flat series is
 * drawn flat, in the middle, rather than divided by a zero range.
 */
const geometry = computed(() => {
  const values = props.points.map((p) => p.value);
  const max = Math.max(1, ...values);
  const span = Math.max(1, props.points.length - 1);
  const plotted = props.points.map((point, i) => ({
    ...point,
    x: PAD + (i / span) * (WIDTH - PAD * 2),
    y: HEIGHT - PAD - (point.value / max) * (HEIGHT - PAD * 2),
    index: i,
  }));

  return { max, plotted, line: plotted.map((p) => `${ p.x.toFixed(1) },${ p.y.toFixed(1) }`).join(' ') };
});

const active = computed(() => (hovered.value === null ? latest.value : props.points[hovered.value]));
</script>

<template>
  <section v-if="points.length" class="trend" aria-label="Items needing action, recent reports">
    <div class="trend__figures">
      <p class="trend__label">
        Needing action
      </p>
      <p class="trend__value">
        {{ active ? active.value : '—' }}
        <span
          v-if="hovered === null && delta !== null && delta !== 0"
          class="trend__delta"
          :class="delta > 0 ? 'is-worse' : 'is-better'"
          :title="`${ delta > 0 ? 'More' : 'Fewer' } than the previous report`"
        >
          {{ delta > 0 ? '+' : '' }}{{ delta }}
        </span>
        <span v-else-if="hovered === null && delta === 0" class="trend__delta is-flat">no change</span>
      </p>
      <p class="trend__caption" aria-live="polite">
        {{ active ? active.date : '' }}<template v-if="hovered === null && points.length > 1"> · last {{ points.length }} reports</template>
      </p>
    </div>

    <svg
      class="trend__chart"
      :viewBox="`0 0 ${ WIDTH } ${ HEIGHT }`"
      :width="WIDTH"
      :height="HEIGHT"
      role="img"
      :aria-label="`Items needing action across the last ${ points.length } reports, most recently ${ latest ? latest.value : 0 }`"
      @mouseleave="hovered = null"
    >
      <polyline
        class="trend__line"
        :points="geometry.line"
        fill="none"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle
        v-for="point in geometry.plotted"
        :key="point.date + point.index"
        class="trend__point"
        :class="{ 'is-latest': point.index === geometry.plotted.length - 1, 'is-hovered': hovered === point.index }"
        :cx="point.x"
        :cy="point.y"
        :r="point.index === geometry.plotted.length - 1 ? 3.6 : 1.8"
      />
      <!-- Hit targets bigger than the marks, so a 2px point is still hoverable. -->
      <rect
        v-for="point in geometry.plotted"
        :key="`hit-${ point.date }-${ point.index }`"
        class="trend__hit"
        :x="point.x - 7"
        y="0"
        width="14"
        :height="HEIGHT"
        @mouseenter="hovered = point.index"
      />
    </svg>
</section>
</template>

<style lang="scss" scoped>
.trend {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--body-bg);

  &__figures {
    min-width: 128px;
  }

  &__label {
    margin: 0;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__value {
    // Proportional figures, not tabular: this is a standalone display number, and giving every
    // digit the width of a zero makes a value like 11 look like it has a gap in it.
    margin: 1px 0 0;
    font-size: 28px;
    font-weight: 600;
    line-height: 32px;
  }

  &__delta {
    margin-left: 8px;
    font-size: 12px;
    font-weight: 600;
    vertical-align: middle;

    // More owed than last time is worse, which is the opposite of the usual "up is good".
    &.is-worse {
      color: var(--error);
    }

    &.is-better {
      color: var(--success);
    }

    &.is-flat {
      color: var(--muted);
      font-weight: 400;
    }
  }

  &__caption {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--muted);
  }

  &__chart {
    flex-shrink: 0;
    overflow: visible;
  }

  &__line {
    stroke: var(--muted);
    opacity: 0.85;
  }

  &__point {
    fill: var(--muted);
    transition: r 0.12s ease;

    &.is-latest {
      fill: var(--error);
    }

    &.is-hovered {
      fill: var(--body-text);
    }
  }

  &__hit {
    fill: transparent;
  }

}

@media (max-width: 720px) {
  .trend {
    flex-wrap: wrap;
    gap: 10px;
  }
}
</style>
