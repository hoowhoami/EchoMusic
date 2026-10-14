<script setup lang="ts">
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Tag from '@/components/ui/Tag.vue';
import { iconChevronDown, iconClipboardList, iconTriangleAlert } from '@/icons';
import {
  dismissTaskEntry,
  getTaskStatusLabel,
  isManuallyDismissibleTask,
  taskPanelEntries,
  taskPanelOpen,
  type TaskEntry,
  type TaskAction,
} from '@/plugins/taskPanel';

const actionVariant = (action: TaskAction) =>
  action.variant === 'primary'
    ? 'primary'
    : action.variant === 'danger'
      ? 'danger'
      : 'soft-secondary';

const progressPercent = (task: TaskEntry): number | null => {
  const { percent, done, total } = task.progress || {};
  const value =
    typeof percent === 'number' && Number.isFinite(percent)
      ? percent
      : typeof done === 'number' &&
          Number.isFinite(done) &&
          typeof total === 'number' &&
          Number.isFinite(total) &&
          total > 0
        ? (done / total) * 100
        : null;
  return value !== null ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10 : null;
};

const progressLabel = (task: TaskEntry): string => {
  const label = task.progress?.label?.trim();
  if (label && label !== getTaskStatusLabel(task.status) && label !== `${progressPercent(task)}%`)
    return label;
  const { done, total } = task.progress || {};
  return typeof done === 'number' &&
    Number.isFinite(done) &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0
    ? `${done} / ${total}`
    : '';
};
</script>

<template>
  <Dialog
    v-model:open="taskPanelOpen"
    title="任务中心"
    content-class="task-panel-dialog"
    show-close
  >
    <div v-if="taskPanelEntries.length === 0" class="task-empty">
      <span class="task-empty-icon" aria-hidden="true">
        <Icon :icon="iconClipboardList" width="28" height="28" />
      </span>
      <strong>暂无任务</strong>
      <p>应用和插件的任务会显示在这里</p>
    </div>
    <div v-else class="task-list">
      <section
        v-for="task in taskPanelEntries"
        :key="task.id"
        class="task-card"
        :data-status="task.status"
        :aria-label="task.name"
      >
        <div class="task-heading">
          <span class="task-icon" aria-hidden="true">
            <Icon :icon="task.icon || iconClipboardList" width="20" height="20" />
          </span>
          <h3 class="task-name">{{ task.name }}</h3>
          <Tag
            class="task-status"
            :tone="task.status === 'running' ? 'accent' : 'neutral'"
            :color="
              task.status === 'error'
                ? 'var(--state-danger)'
                : task.status === 'completed'
                  ? 'var(--state-success)'
                  : undefined
            "
            >{{ getTaskStatusLabel(task.status) }}</Tag
          >
        </div>

        <div
          v-if="progressLabel(task) || progressPercent(task) !== null"
          class="task-progress-copy"
        >
          <span class="task-progress-label">{{ progressLabel(task) }}</span>
          <span v-if="progressPercent(task) !== null" class="task-percent">
            {{ progressPercent(task) }}%
          </span>
        </div>
        <div
          v-if="progressPercent(task) !== null || task.status === 'running'"
          class="task-progress"
          :class="{ 'is-indeterminate': progressPercent(task) === null }"
          role="progressbar"
          :aria-label="`${task.name}进度`"
          :aria-valuenow="progressPercent(task) ?? undefined"
          :aria-valuemin="0"
          :aria-valuemax="100"
        >
          <div
            class="task-progress-bar"
            :style="
              progressPercent(task) !== null ? { width: `${progressPercent(task)}%` } : undefined
            "
          />
        </div>

        <div v-if="task.error" class="task-error">
          <Icon :icon="iconTriangleAlert" width="15" height="15" aria-hidden="true" />
          <p>{{ task.error }}</p>
        </div>

        <details v-if="task.items?.length" class="task-details" :open="task.items.length <= 3">
          <summary>
            <span
              >任务明细 <span class="task-detail-count">{{ task.items.length }} 项</span></span
            >
            <Icon :icon="iconChevronDown" width="14" height="14" aria-hidden="true" />
          </summary>
          <div class="task-detail-list">
            <div v-for="item in task.items" :key="item.id" class="task-detail-row">
              <div class="task-detail-copy">
                <div class="task-detail-heading">
                  <strong>{{ item.name }}</strong>
                  <span v-if="item.statusLabel" class="task-detail-status">{{
                    item.statusLabel
                  }}</span>
                </div>
                <p v-if="item.description" class="task-detail-description">
                  {{ item.description }}
                </p>
                <p v-if="item.error" class="task-detail-error">{{ item.error }}</p>
              </div>
              <div v-if="item.actions?.length" class="task-detail-actions">
                <Button
                  v-for="action in item.actions"
                  :key="action.id"
                  type="button"
                  size="compact"
                  :variant="actionVariant(action)"
                  :disabled="action.disabled"
                  :tooltip="action.label"
                  @click="action.onClick()"
                  ><span class="task-action-label" data-tooltip-label>{{
                    action.label
                  }}</span></Button
                >
              </div>
            </div>
          </div>
        </details>

        <div v-if="task.actions?.length || isManuallyDismissibleTask(task)" class="task-actions">
          <Button
            v-for="action in task.actions"
            :key="action.id"
            type="button"
            :variant="actionVariant(action)"
            :disabled="action.disabled"
            :tooltip="action.label"
            @click="action.onClick()"
            ><span class="task-action-label" data-tooltip-label>{{ action.label }}</span></Button
          >
          <Button
            v-if="isManuallyDismissibleTask(task)"
            type="button"
            variant="soft-secondary"
            @click="dismissTaskEntry(task.id, task.generation)"
            >移除记录</Button
          >
        </div>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
:global(.dialog-content.task-panel-dialog) {
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: min(720px, calc(100vh - 64px));
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.task-card {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--control-muted-bg);
}
.task-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.task-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-control);
  color: var(--color-primary-text);
  background: var(--control-muted-bg);
}
.task-name {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.task-status {
  flex-shrink: 0;
}
.task-progress-copy {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
  margin-top: 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--color-text-secondary);
}
.task-progress-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.task-percent {
  flex-shrink: 0;
  color: var(--color-text-main);
  font-variant-numeric: tabular-nums;
}
.task-progress {
  height: 5px;
  margin-top: 10px;
  border-radius: 999px;
  background: var(--control-hover-bg);
  overflow: hidden;
}
.task-progress-copy + .task-progress {
  margin-top: 6px;
}
.task-progress-bar {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width var(--motion-duration-normal);
}
.task-card[data-status='error'] .task-progress-bar {
  background: var(--state-danger);
}
.task-card[data-status='completed'] .task-progress-bar {
  background: var(--state-success);
}
.task-progress.is-indeterminate .task-progress-bar {
  width: 35%;
  animation: task-progress-pending 1.6s ease-in-out infinite;
}
@keyframes task-progress-pending {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(286%);
  }
}
.task-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 10px;
  border-radius: var(--radius-control);
  color: var(--control-danger-text);
  background: var(--control-danger-bg);
}
.task-error :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}
.task-error p,
.task-detail-copy p {
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.task-details {
  margin-top: 12px;
  border-top: 1px solid var(--border-subtle);
}
.task-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 36px;
  cursor: pointer;
  list-style: none;
  font-size: 12px;
  color: var(--color-text-secondary);
  border-radius: var(--radius-control);
}
.task-details summary::-webkit-details-marker {
  display: none;
}
.task-details summary:hover {
  color: var(--color-text-main);
}
.task-details summary:focus-visible {
  outline: 2px solid var(--color-primary-text);
  outline-offset: 2px;
}
.task-details[open] summary :deep(svg) {
  transform: rotate(180deg);
}
.task-detail-count {
  margin-inline-start: 6px;
  font-variant-numeric: tabular-nums;
}
.task-detail-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 10px 0;
  border-top: 1px solid var(--border-subtle);
}
.task-detail-copy {
  flex: 1;
  min-width: 0;
}
.task-detail-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 2px;
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.task-detail-heading strong {
  font-weight: 500;
}
.task-detail-status,
.task-detail-description {
  color: var(--color-text-secondary);
}
.task-detail-error {
  color: var(--control-danger-text);
}
.task-actions,
.task-detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.task-actions {
  margin-top: 12px;
}
.task-actions :deep(button),
.task-detail-actions :deep(button) {
  max-width: 100%;
}
.task-action-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-detail-actions {
  flex-shrink: 0;
  max-width: 50%;
}
.task-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 36px 12px;
  text-align: center;
}
.task-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: 4px;
  border-radius: var(--radius-card);
  color: var(--color-text-secondary);
  background: var(--control-muted-bg);
}
.task-empty strong {
  font-size: 14px;
  font-weight: 500;
}
.task-empty p {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--color-text-secondary);
}
@media (max-width: 420px) {
  .task-card {
    padding: 12px;
  }
  .task-detail-row {
    flex-wrap: wrap;
  }
  .task-detail-copy {
    flex-basis: 100%;
  }
  .task-detail-actions {
    max-width: 100%;
    margin-inline-start: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .task-progress.is-indeterminate .task-progress-bar {
    animation: none;
    transform: translateX(90%);
  }
}
</style>
