<script setup lang="ts">
// One item of the report - a Jira ticket, a community issue or an open question.
//
// The three are one component because they are one thing to the engineer reading them: a
// reference to open, why it is on the list, what to do, and the message to send. Only the chips
// along the top differ, and those come in as a list rather than as three branches of markup.
import { computed } from 'vue';
import CopyButton from './CopyButton.vue';
import { classStyle, verbWeight } from '../lib/format';
import type { ItemClass, LinkedPr, NextStep, QuickAction } from '../types';

const props = defineProps<{
  /** "SURE-12028" or "#18981" - what the engineer will search for. */
  reference: string;
  url: string;
  title: string;
  itemClass?: ItemClass | string | null;
  /** Short facts: priority, age, comment count. Rendered in order, blanks dropped. */
  chips?: { label: string; value: string }[];
  lastActivity?: { who?: string; days_ago?: number | null; context?: string } | null;
  linkedPrs?: LinkedPr[];
  nextStep: NextStep;
  suggestedComment?: string | null;
  quickAction?: QuickAction | null;
}>();

const style = computed(() => classStyle(props.itemClass));
const weight = computed(() => verbWeight(props.nextStep?.verb));
const chips = computed(() => (props.chips || []).filter((c) => !!c.value));

const activity = computed(() => {
  const value = props.lastActivity;

  if (!value?.who && !value?.context) {
    return null;
  }

  const days = value?.days_ago;
  const when = days === null || days === undefined ? '' : days <= 0 ? 'today' : `${ days }d ago`;

  return { who: value?.who || 'last activity', when, context: value?.context || '' };
});
</script>

<template>
  <article class="item" :style="{ '--item-color': `var(${ style.colorVar })` }" data-testid="idr-item">
    <header class="item__head">
      <a :href="url" target="_blank" rel="noopener noreferrer" class="item__ref">
        {{ reference }}
        <i class="icon icon-external-link" />
      </a>
      <span class="item__badge" :title="style.hint">
        <i class="icon" :class="style.icon" />
        {{ style.label }}
      </span>
    </header>

    <h4 class="item__title">
      {{ title }}
    </h4>

    <ul v-if="chips.length" class="item__chips">
      <li v-for="chip in chips" :key="chip.label">
        <span class="item__chip-label">{{ chip.label }}</span>
        <span class="item__chip-value">{{ chip.value }}</span>
      </li>
    </ul>

    <p v-if="activity" class="item__activity">
      <i class="icon icon-chat" />
      <span>
        <strong>{{ activity.who }}</strong><template v-if="activity.when">, {{ activity.when }}</template>
        <template v-if="activity.context"> — {{ activity.context }}</template>
      </span>
    </p>

    <ul v-if="linkedPrs && linkedPrs.length" class="item__prs">
      <li v-for="pr in linkedPrs" :key="pr.number">
        <a :href="pr.url" target="_blank" rel="noopener noreferrer">
          <i class="icon icon-pull-request" />
          #{{ pr.number }}
        </a>
        <span class="item__pr-state" :class="`state-${ String(pr.state || '').toLowerCase() }`">{{ pr.state }}</span>
      </li>
    </ul>

    <div class="item__step" :class="`weight-${ weight }`">
      <span class="item__verb">{{ nextStep?.verb || 'REVIEW' }}</span>
      <p class="item__explanation">
        {{ nextStep?.explanation }}
      </p>
    </div>

    <a
      v-if="quickAction"
      :href="quickAction.url"
      target="_blank"
      rel="noopener noreferrer"
      class="item__quick"
    >
      <i class="icon icon-plus" />
      {{ quickAction.label }}
    </a>

    <section v-if="suggestedComment" class="item__comment">
      <header class="item__comment-head">
        <span>Suggested comment</span>
        <CopyButton :text="suggestedComment" />
      </header>
      <p class="item__comment-body">
        {{ suggestedComment }}
      </p>
    </section>
  </article>
</template>

<style lang="scss" scoped>
.item {
  position: relative;
  padding: 14px 16px 14px 20px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--body-bg);
  overflow: hidden;

  // The class stripe. It is the first thing read on a page of a dozen of these, so it is the
  // one piece of colour that is always in the same place.
  &::before {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 4px;
    background: var(--item-color);
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__ref {
    font-family: var(--font-family-mono, monospace);
    font-size: 13px;
    font-weight: 600;

    .icon {
      font-size: 11px;
      opacity: 0.7;
    }
  }

  &__badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 11px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--item-color);
    border: 1px solid var(--item-color);
    white-space: nowrap;

    .icon {
      font-size: 12px;
    }
  }

  &__title {
    margin: 6px 0 10px;
    font-size: 15px;
    font-weight: 600;
    line-height: 21px;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 10px;
    padding: 0;
    list-style: none;

    li {
      display: inline-flex;
      align-items: baseline;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--nav-bg);
      font-size: 11px;
    }
  }

  &__chip-label {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-size: 10px;
  }

  &__chip-value {
    font-weight: 600;
  }

  &__activity {
    display: flex;
    gap: 7px;
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 12px;
    line-height: 18px;

    .icon {
      margin-top: 2px;
      flex-shrink: 0;
    }

    strong {
      color: var(--body-text);
    }
  }

  &__prs {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 0 0 10px;
    padding: 0;
    list-style: none;
    font-size: 12px;

    li {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
  }

  &__pr-state {
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    background: var(--nav-bg);
    color: var(--muted);

    &.state-open {
      color: var(--success);
    }

    &.state-merged {
      color: var(--info);
    }

    &.state-closed {
      color: var(--error);
    }
  }

  &__step {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 5px;
    background: var(--nav-bg);
    border-left: 3px solid var(--muted);

    &.weight-act {
      border-left-color: var(--error);
    }

    &.weight-chase {
      border-left-color: var(--warning);
    }

    &.weight-watch {
      border-left-color: var(--success);
    }
  }

  &__verb {
    flex-shrink: 0;
    font-family: var(--font-family-mono, monospace);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 3px;
    background: var(--body-bg);
    border: 1px solid var(--border);
    white-space: nowrap;
  }

  &__explanation {
    margin: 0;
    font-size: 13px;
    line-height: 19px;
  }

  &__quick {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    font-size: 12px;
    font-weight: 600;
  }

  &__comment {
    margin-top: 10px;
    border: 1px dashed var(--border);
    border-radius: 5px;
    overflow: hidden;
  }

  &__comment-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    background: var(--nav-bg);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  &__comment-body {
    margin: 0;
    padding: 10px 12px;
    font-size: 13px;
    line-height: 20px;
    white-space: pre-wrap;
  }
}
</style>
