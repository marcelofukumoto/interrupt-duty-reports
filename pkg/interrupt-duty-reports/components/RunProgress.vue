<script setup lang="ts">
// What a run is doing, while it does it.
//
// The four steps are read off the files the run has produced, not off the terminal, so this
// says where the run actually is rather than what claude last printed. The pane's output is
// still there - a run that stalls is a run somebody will want to look inside - but it is behind
// a disclosure rather than being the headline, because raw scrollback is the least readable
// thing on the page and it was the first thing the eye landed on.
import { computed, ref } from 'vue';
import { PHASE_LABEL } from '../lib/format';
import { RUN_PHASES } from '../lib/run';
import type { RunPhase } from '../lib/run';

const props = defineProps<{
  phase: RunPhase;
  output: string;
  elapsed: string;
}>();

const showOutput = ref(false);

const steps = computed(() => {
  const at = RUN_PHASES.indexOf(props.phase);

  return RUN_PHASES.map((phase, i) => ({
    phase,
    label: PHASE_LABEL[phase] || phase,
    state: i < at ? 'done' : i === at ? 'active' : 'todo',
  }));
});
</script>

<template>
  <div class="progress" data-testid="idr-progress">
    <ol class="progress__steps">
      <li
        v-for="step in steps"
        :key="step.phase"
        class="progress__step"
        :class="`is-${ step.state }`"
      >
        <span class="progress__marker">
          <i v-if="step.state === 'done'" class="icon icon-checkmark" />
          <i v-else-if="step.state === 'active'" class="icon icon-spinner icon-spin" />
        </span>
        <span class="progress__label">{{ step.label }}</span>
      </li>
    </ol>

    <div class="progress__foot">
      <span class="progress__elapsed">{{ elapsed }}</span>
      <button
        v-if="output"
        type="button"
        class="progress__toggle"
        :aria-expanded="showOutput"
        data-testid="idr-progress-toggle"
        @click.stop="showOutput = !showOutput"
      >
        <i class="icon" :class="showOutput ? 'icon-chevron-up' : 'icon-chevron-down'" />
        {{ showOutput ? 'Hide' : 'Show' }} agent output
      </button>
    </div>

    <pre v-if="showOutput && output" class="progress__output">{{ output }}</pre>
  </div>
</template>

<style lang="scss" scoped>
.progress {
  margin-top: 10px;

  &__steps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 6px;
    border-radius: 12px;
    font-size: 11px;
    color: var(--muted);
    background: var(--nav-bg);

    // A chevron between steps rather than a connecting rail, which would have to survive the
    // steps wrapping onto a second line at narrow widths.
    & + & {
      position: relative;
      margin-left: 8px;

      &::before {
        content: '›';
        position: absolute;
        left: -10px;
        color: var(--muted);
        opacity: 0.6;
      }
    }

    &.is-done {
      color: var(--success);
    }

    &.is-active {
      color: var(--body-text);
      background: var(--accent-btn);
      font-weight: 600;
    }

    &.is-todo {
      opacity: 0.55;
    }
  }

  &__marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 13px;
    height: 13px;

    .icon {
      font-size: 11px;
    }
  }

  // A step not yet reached still needs its marker's width, or the labels jump left as each one
  // completes.
  &__step.is-todo &__marker::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    border: 1px solid currentColor;
  }

  &__foot {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
  }

  &__elapsed {
    font-variant-numeric: tabular-nums;
  }

  &__toggle {
    border: none;
    background: transparent;
    color: var(--link);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;

    &:hover {
      text-decoration: underline;
    }
  }

  &__output {
    margin: 8px 0 0;
    padding: 9px 11px;
    max-height: 140px;
    overflow: auto;
    border-radius: 4px;
    background: var(--nav-bg);
    color: var(--muted);
    font-family: var(--font-family-mono, monospace);
    font-size: 11px;
    line-height: 16px;
    white-space: pre-wrap;
    word-break: break-word;
  }
}
</style>
