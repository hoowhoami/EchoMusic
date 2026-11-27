<script setup lang="ts">
import { computed } from 'vue';
import { vTooltip } from '@/components/ui/tooltip';

/**
 * 续播卡本体：搜索页右上角那摞牌堆和播放时贴出来的提示卡用的是同一个组件。
 * 外面那圈半透明毛玻璃、封面、书名、「类别 · 章节 · 时间」两行都在这里定，
 * 位置、层叠角度、飞行/粉碎动画由使用方（SearchHeader）自己管。
 */
const props = withDefaults(
  defineProps<{
    name: string;
    cover?: string;
    kindLabel: string;
    /** 第二行「类别」后面的部分：搜索页传「章节 · 07:12」，提示卡传同一套文案 */
    hint: string;
    /** 牌堆里最上面那张：内容淡入 */
    open?: boolean;
    /** 唤出右侧删除区 */
    revealed?: boolean;
    /** 展开成竖列表：这时不按「只留封面」处理 */
    listMode?: boolean;
    /** 悬停显示被截断的文字（牌堆里有，浮动提示卡不需要） */
    tooltip?: boolean;
  }>(),
  { cover: '', open: false, revealed: false, listMode: false, tooltip: false },
);

const placeholder = computed(() => props.name.trim().slice(0, 1) || '♪');

/** 悬停提示跟着这两个属性走：要显示、且删除区没打开 */
const tip = (content: string) => ({
  content,
  mode: 'overflow' as const,
  delayDuration: 1000,
  side: 'bottom' as const,
  disabled: !props.tooltip || props.revealed,
});
</script>

<template>
  <button
    type="button"
    class="resume-card"
    :class="{ 'is-open': open, 'is-revealed': revealed, 'is-list': listMode }"
  >
    <span class="resume-card-inner">
      <span class="resume-card-cover">
        <img v-if="cover" :src="cover" alt="" loading="lazy" />
        <span v-else class="resume-card-placeholder">{{ placeholder }}</span>
      </span>
      <span class="resume-card-body">
        <span v-tooltip="tip(name)" class="resume-card-name" data-tooltip-label>{{ name }}</span>
        <span v-tooltip="tip(`${kindLabel} · ${hint}`)" class="resume-card-hint" data-tooltip-label
          >{{ kindLabel }} · {{ hint }}</span
        >
      </span>
    </span>
    <slot />
  </button>
</template>

<style scoped>
.resume-card {
  /* 删除区参数：内容左移量 / 唤出与收起共用的缓动（同一族，末段阻尼更明显） */
  --resume-reveal-width: 64px;
  --resume-reveal-duration: 340ms;
  --resume-reveal-ease: cubic-bezier(0.2, 1.16, 0.3, 1);
  display: block;
  height: 52px;
  padding: 0;
  overflow: hidden;
  text-align: left;
  border-radius: 10px;
  /* 边框带一丝丝白：用 --text-main 调，深色主题是淡白描边、浅色主题自动变淡墨描边 */
  border: 1px solid color-mix(in srgb, var(--text-main, #ffffff) 22%, transparent);
  /* 卡片自己就是半透明毛玻璃：后面的页面内容透过来并被虚化 */
  --surface-card-opacity: 42%;
  background: color-mix(
    in srgb,
    var(--surface-card-base, #343436) var(--surface-card-opacity, 100%),
    transparent
  );
  /* 只写不带前缀的那一条：压缩时若同时存在 -webkit- 版本，构建会只留前缀版，本机 Chromium 不认 */
  backdrop-filter: blur(14px) saturate(1.1);
  box-shadow: 2px 0 8px rgb(0 0 0 / 18%);
  cursor: pointer;
}

.resume-card-cover {
  display: flex;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  align-items: center;
  justify-content: center;
  background: var(--surface-4, rgb(255 255 255 / 12%));
  font-size: 15px;
  font-weight: 600;
  color: var(--text-secondary, #b3b3b3);
}

.resume-card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.resume-card-body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.resume-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resume-card-hint {
  font-size: 11px;
  color: var(--text-secondary, #b3b3b3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 内容层：唤出删除区时整体左移，外框位置与尺寸一律不动 */
.resume-card-inner {
  display: flex;
  height: 100%;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  transform: translate3d(0, 0, 0);
  transition: transform var(--resume-reveal-duration) var(--resume-reveal-ease);
  will-change: transform;
}

.resume-card.is-revealed .resume-card-inner {
  transform: translate3d(calc(-1 * var(--resume-reveal-width)), 0, 0);
}

.resume-card.is-open {
  background-image: none;
}

/* 牌堆里后面的卡片只渲染封面：露出来的那一小条就是它的封面图，文字不露 */
.resume-card:not(.is-open):not(.is-list) .resume-card-body {
  opacity: 0;
}

/* 翻到最前面时才把内容淡入，像是在抽纸 */
.resume-card.is-open .resume-card-cover,
.resume-card.is-open .resume-card-body {
  animation: resume-card-content-in 260ms ease-out 120ms both;
}

@keyframes resume-card-content-in {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* 竖排滚轮换内容：内容原地淡入，卡片本身靠 bounceCards 做侧面滑动 */
.resume-card.is-list .resume-card-cover,
.resume-card.is-list .resume-card-body {
  animation: resume-list-content-in 200ms ease-out both;
}

@keyframes resume-list-content-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .resume-card.is-open .resume-card-cover,
  .resume-card.is-open .resume-card-body,
  .resume-card.is-list .resume-card-cover,
  .resume-card.is-list .resume-card-body {
    animation: none;
  }
}
</style>
