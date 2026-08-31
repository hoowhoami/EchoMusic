<script setup lang="ts">
import { computed } from 'vue';
import type { HTMLAttributes } from 'vue';
import { parseDate, type CalendarDate, type DateValue } from '@internationalized/date';
import {
  DatePickerAnchor,
  DatePickerCalendar,
  DatePickerCell,
  DatePickerCellTrigger,
  DatePickerContent,
  DatePickerField,
  DatePickerGrid,
  DatePickerGridBody,
  DatePickerGridHead,
  DatePickerGridRow,
  DatePickerHeadCell,
  DatePickerHeader,
  DatePickerHeading,
  DatePickerInput,
  DatePickerNext,
  DatePickerPrev,
  DatePickerRoot,
  DatePickerTrigger,
} from 'reka-ui';
import {
  iconCalendar,
  iconChevronLeft,
  iconChevronRight,
  iconChevronsLeft,
  iconChevronsRight,
  iconX,
} from '@/icons';

interface Props {
  modelValue?: string;
  placeholder?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  clearable?: boolean;
  locale?: string;
  ariaLabel?: string;
  class?: HTMLAttributes['class'];
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '请选择日期',
  disabled: false,
  clearable: false,
  locale: 'zh-CN',
  ariaLabel: '日期',
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const parseIsoDate = (value?: string): CalendarDate | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  try {
    return parseDate(value);
  } catch {
    return undefined;
  }
};

const selectedDate = computed<CalendarDate | undefined>({
  get: () => parseIsoDate(props.modelValue),
  set: (value) => emit('update:modelValue', value?.toString() ?? ''),
});

const minValue = computed(() => parseIsoDate(props.min));
const maxValue = computed(() => parseIsoDate(props.max));

const previousYear = (date: DateValue) => date.subtract({ years: 1 });
const nextYear = (date: DateValue) => date.add({ years: 1 });
</script>

<template>
  <DatePickerRoot
    v-model="selectedDate"
    :locale="locale"
    :min-value="minValue"
    :max-value="maxValue"
    :disabled="disabled"
    :close-on-select="true"
    :prevent-deselect="true"
    weekday-format="short"
  >
    <DatePickerAnchor as-child>
      <DatePickerField
        v-slot="{ segments }"
        :class="['echo-date-picker-field', props.class]"
        :aria-label="ariaLabel"
      >
        <span v-if="!selectedDate" class="echo-date-picker-placeholder">{{ placeholder }}</span>
        <div class="echo-date-picker-segments" :class="{ 'is-placeholder': !selectedDate }">
          <DatePickerInput
            v-for="segment in segments"
            :key="segment.part"
            :part="segment.part"
            :class="[
              'echo-date-picker-segment',
              { 'echo-date-picker-literal': segment.part === 'literal' },
            ]"
          >
            {{ segment.value }}
          </DatePickerInput>
        </div>

        <button
          v-if="clearable && selectedDate"
          type="button"
          class="echo-date-picker-action"
          aria-label="清除日期"
          @click.stop="selectedDate = undefined"
        >
          <Icon :icon="iconX" width="14" height="14" />
        </button>

        <DatePickerTrigger class="echo-date-picker-action" aria-label="打开日期选择器">
          <Icon :icon="iconCalendar" width="17" height="17" />
        </DatePickerTrigger>
      </DatePickerField>
    </DatePickerAnchor>

    <DatePickerContent
      class="echo-date-picker-content"
      side="bottom"
      align="start"
      :side-offset="7"
      :collision-padding="12"
    >
      <DatePickerCalendar v-slot="{ weekDays, grid }">
        <DatePickerHeader class="echo-date-picker-header">
          <div class="echo-date-picker-navigation">
            <DatePickerPrev
              class="echo-date-picker-nav-button"
              :prev-page="previousYear"
              title="上一年"
            >
              <Icon :icon="iconChevronsLeft" width="16" height="16" />
            </DatePickerPrev>
            <DatePickerPrev class="echo-date-picker-nav-button" title="上个月">
              <Icon :icon="iconChevronLeft" width="16" height="16" />
            </DatePickerPrev>
          </div>

          <DatePickerHeading class="echo-date-picker-heading" />

          <div class="echo-date-picker-navigation">
            <DatePickerNext class="echo-date-picker-nav-button" title="下个月">
              <Icon :icon="iconChevronRight" width="16" height="16" />
            </DatePickerNext>
            <DatePickerNext
              class="echo-date-picker-nav-button"
              :next-page="nextYear"
              title="下一年"
            >
              <Icon :icon="iconChevronsRight" width="16" height="16" />
            </DatePickerNext>
          </div>
        </DatePickerHeader>

        <DatePickerGrid
          v-for="month in grid"
          :key="month.value.toString()"
          class="echo-date-picker-grid"
        >
          <DatePickerGridHead>
            <DatePickerGridRow class="echo-date-picker-grid-row">
              <DatePickerHeadCell
                v-for="day in weekDays"
                :key="day"
                class="echo-date-picker-weekday"
              >
                {{ day }}
              </DatePickerHeadCell>
            </DatePickerGridRow>
          </DatePickerGridHead>
          <DatePickerGridBody>
            <DatePickerGridRow
              v-for="(week, weekIndex) in month.rows"
              :key="weekIndex"
              class="echo-date-picker-grid-row"
            >
              <DatePickerCell
                v-for="day in week"
                :key="day.toString()"
                :date="day"
                class="echo-date-picker-cell"
              >
                <DatePickerCellTrigger
                  :day="day"
                  :month="month.value"
                  class="echo-date-picker-day"
                />
              </DatePickerCell>
            </DatePickerGridRow>
          </DatePickerGridBody>
        </DatePickerGrid>
      </DatePickerCalendar>
    </DatePickerContent>
  </DatePickerRoot>
</template>

<style scoped>
.echo-date-picker-field {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 44px;
  min-width: 0;
  padding: 0 8px 0 13px;
  color: var(--color-text-main);
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
  border-radius: 12px;
  outline: none;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.echo-date-picker-field:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.12);
}

.echo-date-picker-field[data-disabled] {
  cursor: not-allowed;
  opacity: 0.55;
}

.echo-date-picker-placeholder {
  position: absolute;
  left: 13px;
  overflow: hidden;
  max-width: calc(100% - 52px);
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0.65;
}

.echo-date-picker-segments {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.echo-date-picker-segments.is-placeholder {
  opacity: 0;
}

.echo-date-picker-segments.is-placeholder:focus-within {
  opacity: 1;
}

.echo-date-picker-field:has(.echo-date-picker-segments:focus-within) .echo-date-picker-placeholder {
  display: none;
}

.echo-date-picker-segment {
  min-width: 1.4em;
  padding: 3px 2px;
  border-radius: 5px;
  outline: none;
  text-align: center;
  caret-color: transparent;
}

.echo-date-picker-segment:focus {
  color: var(--color-primary);
  background: rgba(var(--color-primary-rgb), 0.12);
}

.echo-date-picker-literal {
  min-width: auto;
  padding-inline: 0;
}

.echo-date-picker-action {
  display: inline-flex;
  flex: 0 0 28px;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: 8px;
  outline: none;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}

.echo-date-picker-action:hover,
.echo-date-picker-action:focus-visible {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}
</style>

<!-- DatePickerContent 会被 Portal 到 body，弹层样式不能使用 scoped。 -->
<style>
.echo-date-picker-content {
  z-index: 10020;
  width: 304px;
  padding: 12px;
  color: var(--color-text-main);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  box-shadow: var(--shadow-elevated);
  outline: none;
  transform-origin: var(--reka-popover-content-transform-origin);
  animation: echo-date-picker-in 0.16s ease-out;
}

.echo-date-picker-header {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr) 72px;
  align-items: center;
  margin-bottom: 8px;
}

.echo-date-picker-navigation {
  display: flex;
  gap: 2px;
}

.echo-date-picker-nav-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: 9px;
  outline: none;
}

.echo-date-picker-nav-button:hover,
.echo-date-picker-nav-button:focus-visible {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.echo-date-picker-nav-button[data-disabled] {
  pointer-events: none;
  opacity: 0.25;
}

.echo-date-picker-heading {
  overflow: hidden;
  font-size: 13px;
  font-weight: 800;
  text-align: center;
  white-space: nowrap;
}

.echo-date-picker-grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 2px;
}

.echo-date-picker-grid-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}

.echo-date-picker-weekday {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 800;
}

.echo-date-picker-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.echo-date-picker-day {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  background: transparent;
  border: 0;
  border-radius: 10px;
  outline: none;
  cursor: pointer;
}

.echo-date-picker-day:hover,
.echo-date-picker-day:focus-visible {
  background: var(--control-hover-bg);
}

.echo-date-picker-day[data-today] {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 16%, transparent);
  box-shadow: inset 0 0 0 1px rgba(var(--color-primary-rgb), 0.6);
}

.echo-date-picker-day[data-focused]:not([data-selected]) {
  box-shadow: inset 0 0 0 2px rgba(var(--color-primary-rgb), 0.72);
}

.echo-date-picker-day[data-selected] {
  color: #fff;
  background: var(--color-primary);
  box-shadow: none;
}

.echo-date-picker-day[data-outside-view] {
  opacity: 0.3;
}

.echo-date-picker-day[data-disabled],
.echo-date-picker-day[data-unavailable] {
  cursor: not-allowed;
  opacity: 0.25;
  pointer-events: none;
}

@keyframes echo-date-picker-in {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
