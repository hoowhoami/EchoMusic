<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ResumeDeck from '@/components/music/ResumeDeck.vue';
import { usePlayerStore } from '@/stores/player';
import {
  RESUME_LOCATE_FAILED_TEXT,
  dismissResumeHint,
  dropResumeHintCard,
  navigateResumeTarget,
  requestResumeHintPlay,
  resumeHintRequest,
  resumeHintState,
  setResumeHintHeld,
  type ResumeHintCard,
} from '@/utils/resumeHint';
import { useToastStore } from '@/stores/toast';
import type { ResumeEntryCard } from '@/views/search/resumeCard';
import { formatDuration } from '@/utils/format';

const props = defineProps<{
  /** 定位基准：顶部搜索框那块区域，卡片贴在它右下角。 */
  anchor?: HTMLElement | null;
}>();

const route = useRoute();
const router = useRouter();
const playerStore = usePlayerStore();
const toastStore = useToastStore();

/** 卡宽：与搜索页牌堆同一尺寸 */
const CARD_WIDTH = 300;
const CARD_HEIGHT = 52;
/** 整摞占位高度：卡片 52 + 上下各 7 的留白（与 ResumeDeck 的 DECK_HEIGHT 一致） */
const DECK_HEIGHT = CARD_HEIGHT + 14;
/** 每多一张往左错开的量（与 ResumeDeck 的 MAX_FAN_STEP 一致） */
const FAN_STEP = 46;
const MARGIN = 8;
/** 基准点 = 搜索框右下角 + (50, 12)，这个点就是最上面那张卡的左上角（纵向与搜索页牌堆齐平） */
const CARD_OFFSET_X = 50;
const CARD_OFFSET_Y = 12;
/** 往右躲文字时最多挤到「卡片右沿距窗口右边栏 100px」，再往右不行 */
const CARD_RIGHT_RESERVE = 100;
/** 躲文字时一小步一小步挪，挪开字就停，不会一步跨过界 */
const PUSH_STEP = 4;
/** 采样密度：5×4 个点够判断这块矩形压没压住字 */
const SAMPLE_X = 5;
const SAMPLE_Y = 4;
/** 比页面文字晚半秒出现 */
const REVEAL_DELAY_MS = 500;
/** 常驻卡点完给页面留的认领时间：这段时间没人认领，就是没能定位/起播 */
const PERSISTENT_SETTLE_MS = 1500;

const cardEl = ref<HTMLElement | null>(null);
/** 竖列表展开着：这时定位壳要让路，不然第一行被壳挡住点不到 */
const listExpanded = ref(false);
const deckRef = ref<InstanceType<typeof ResumeDeck> | null>(null);
const left = ref(MARGIN);
const top = ref(0);
/** 当前落点：规则是确定的（同一锚点、同一页面内容总算出同一个点），缓存只为省掉逐帧采样 */
let chosen: { left: number; top: number } | null = null;
/** 本页面已经定过的落点：同一个页面里只在第一次定位，之后（顶替、展开收回收起）都用它 */
let lockedSpot: { left: number; top: number } | null = null;
/** 位置稳住了还要再等一下才上屏，避免抢在页面文字前面弹出来 */
const ready = ref(false);
let stableSpot: { left: number; top: number } | null = null;
let revealTimer = 0;

/** 后面几张卡往左错开的总宽 */
const spread = computed(() => Math.max(0, resumeHintState.cards.length - 1) * FAN_STEP);
/** 整摞卡占的宽：最上面那张 + 后面露出来的几条边 */
const deckWidth = computed(() => CARD_WIDTH + spread.value);

/** 骨架屏、占位文案、加载失败提示都算临时文字：随时会被真内容换掉，不参与「压没压着字」的判断 */
const TRANSIENT_TEXT_SELECTOR = '[class*="skeleton"], [class*="placeholder"], .detail-page-error';

/**
 * 这个像素上有没有字形：caretRangeFromPoint 拿到光标所在的文本节点和偏移，
 * 再按「单字」量字盒 —— 整段文字的行盒会撑满容器宽度，用它判断会把旁边的空白也算成文字。
 */
const hasTextAt = (px: number, py: number): boolean => {
  type CaretDoc = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const caretDoc = document as CaretDoc;
  const caret = caretDoc.caretRangeFromPoint?.(px, py) ?? null;
  let node: Node | null = caret?.startContainer ?? null;
  let offset = caret?.startOffset ?? 0;
  if (!node) {
    const position = caretDoc.caretPositionFromPoint?.(px, py) ?? null;
    node = position?.offsetNode ?? null;
    offset = position?.offset ?? 0;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.textContent ?? '';
  if (!text.trim()) return false;
  if (node.parentElement?.closest(TRANSIENT_TEXT_SELECTOR)) return false;
  // 光标两侧各取一个字量：任何一个字的字盒盖住采样点，就算这里压着字
  for (const [from, to] of [
    [offset, offset + 1],
    [offset - 1, offset],
  ]) {
    if (from < 0 || to > text.length || from >= to) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    for (const box of Array.from(range.getClientRects())) {
      if (px >= box.left - 1 && px <= box.right + 1 && py >= box.top - 1 && py <= box.bottom + 1) {
        return true;
      }
    }
  }
  return false;
};

/** 这块矩形里有没有被卡片挡住的字：量的时候先把自己藏起来，不然量到的是卡片自己的字 */
const hasTextInside = (spotLeft: number, spotTop: number): boolean => {
  const card = cardEl.value;
  const previousVisibility = card?.style.visibility ?? '';
  if (card) card.style.visibility = 'hidden';
  try {
    for (let ix = 0; ix < SAMPLE_X; ix += 1) {
      for (let iy = 0; iy < SAMPLE_Y; iy += 1) {
        const px = Math.round(spotLeft + ((ix + 0.5) / SAMPLE_X) * deckWidth.value);
        const py = Math.round(spotTop + ((iy + 0.5) / SAMPLE_Y) * DECK_HEIGHT);
        if (px < 0 || py < 0 || px >= window.innerWidth || py >= window.innerHeight) continue;
        if (hasTextAt(px, py)) return true;
      }
    }
    return false;
  } finally {
    if (card) card.style.visibility = previousVisibility;
  }
};

/**
 * 落点规则（和之前一样，只是把「一张卡」换成「整摞卡」）：
 * 1. 最上面那张的左下角基准 = 搜索框右下角 + (50, 20)，纵向就定在这儿；
 * 2. 压着字就把整摞沿水平方向一步步往右挤，挤到不压字就停；
 * 3. 最多挤到「最上面那张的右沿距窗口右边栏 100px」，挤到那儿就不动了（上限优先）。
 */
const pickSpot = (anchorRect: DOMRect) => {
  const spotTop = Math.round(
    Math.min(
      Math.max(MARGIN, anchorRect.bottom + CARD_OFFSET_Y),
      Math.max(MARGIN, window.innerHeight - MARGIN - DECK_HEIGHT),
    ),
  );
  const limitCardLeft = Math.max(
    MARGIN,
    Math.round(window.innerWidth - CARD_RIGHT_RESERVE - CARD_WIDTH),
  );
  let cardLeft = Math.min(
    Math.max(MARGIN, Math.round(anchorRect.right + CARD_OFFSET_X)),
    limitCardLeft,
  );
  let spotLeft = Math.max(MARGIN, cardLeft - spread.value);
  while (cardLeft < limitCardLeft && hasTextInside(spotLeft, spotTop)) {
    cardLeft = Math.min(limitCardLeft, cardLeft + PUSH_STEP);
    spotLeft = Math.max(MARGIN, cardLeft - spread.value);
  }
  return { left: spotLeft, top: spotTop };
};

/** 把缓存落点写进样式；顺手按同样的上限夹一次，窗口变窄也不会越界 */
const applySpot = () => {
  if (!chosen) return;
  const limitLeft = Math.max(
    MARGIN,
    Math.round(window.innerWidth - CARD_RIGHT_RESERVE - deckWidth.value),
  );
  const maxTop = Math.max(MARGIN, window.innerHeight - MARGIN - DECK_HEIGHT);
  left.value = Math.round(Math.min(Math.max(MARGIN, chosen.left), limitLeft));
  top.value = Math.round(Math.min(Math.max(MARGIN, chosen.top), maxTop));
};

/** 把当前落点记成本页面锁定落点 */
const lockChosen = () => {
  if (chosen) lockedSpot = { left: chosen.left, top: chosen.top };
};

/** rescan=true 时重新算落点（刚打开、换了一批卡、窗口大小变），其余时候只按缓存夹取 */
const place = (rescan = false) => {
  const rect = props.anchor?.getBoundingClientRect();
  if (!rect) return;
  if (rescan || !chosen) chosen = pickSpot(rect);
  applySpot();
};

/**
 * 页面内容是异步填进来的，隔一会儿按同一套规则重算一次。
 * 已经亮在屏幕上之后，只有「当前这个位置真的压着字」才往右挪；
 * 纵向位置一律不动 —— 卡片不许跟着页面上下漂。
 */
const rescanSpot = () => {
  // 落点已经定下来了：页面内容再怎么变也不挪，免得同页来回跳
  if (lockedSpot) return;
  const rect = props.anchor?.getBoundingClientRect();
  if (!rect) return;
  const current = chosen ?? pickSpot(rect);
  if (!hasTextInside(current.left, current.top)) return;
  const next = pickSpot(rect);
  chosen = { left: next.left, top: current.top };
};

let followFrame = 0;
let lastFollowAt = 0;
let lastRescanAt = 0;
/** 页面内容是异步填进来的：卡片往往比内容先出现，所以开着的时候要隔一会儿重挑一次位置 */
const RESCAN_MS = 500;

const handleResize = () => {
  chosen = null;
  lockedSpot = null;
  place(true);
  lockChosen();
};

const stopFollow = () => {
  if (followFrame) window.cancelAnimationFrame(followFrame);
  followFrame = 0;
  if (revealTimer) window.clearTimeout(revealTimer);
  revealTimer = 0;
  window.removeEventListener('resize', handleResize);
};

// 卡片开着的时候一直盯着锚点：换页那一下标题栏会先排在别处再归位，
// 只算一次（或只跟几秒）都会把卡留在错的位置，所以按帧低频率重算位置（不重扫占用）。
const followLoop = (now: number) => {
  if (!resumeHintState.open) {
    followFrame = 0;
    return;
  }
  if (now - lastFollowAt >= 60) {
    lastFollowAt = now;
    const anchorRect = props.anchor?.getBoundingClientRect();
    if (anchorRect && !ready.value) {
      // 上屏前：边等边量，位置连续两次算出同一个点就算稳住了
      const spot = pickSpot(anchorRect);
      const settled =
        stableSpot !== null && spot.left === stableSpot.left && spot.top === stableSpot.top;
      stableSpot = spot;
      chosen = spot;
      applySpot();
      // 稳住后再等半秒才出现，别抢在页面文字前面弹出来
      if (settled && !revealTimer) {
        revealTimer = window.setTimeout(() => {
          revealTimer = 0;
          if (resumeHintState.open) ready.value = true;
        }, REVEAL_DELAY_MS);
      }
    } else if (anchorRect) {
      if (!chosen) chosen = pickSpot(anchorRect);
      if (now - lastRescanAt >= RESCAN_MS) {
        lastRescanAt = now;
        rescanSpot();
      }
      applySpot();
    }
  }
  followFrame = window.requestAnimationFrame(followLoop);
};

const startFollow = (rescan = false) => {
  stopFollow();
  // 同一页面换卡（顶替）：沿用已经定过的落点，不重新挑
  if (rescan) chosen = lockedSpot ? { left: lockedSpot.left, top: lockedSpot.top } : null;
  ready.value = false;
  stableSpot = null;
  window.addEventListener('resize', handleResize);
  lastFollowAt = 0;
  lastRescanAt = 0;
  followFrame = window.requestAnimationFrame(followLoop);
};

watch(
  () => resumeHintState.open,
  (open) => {
    if (open) startFollow(true);
    else stopFollow();
  },
  { immediate: true },
);

// 顶替时会换 token：旧的一摞收掉、新的一摞出来，位置重新挑一次
watch(
  () => resumeHintState.token,
  () => {
    if (resumeHintState.open) startFollow(true);
  },
);

// 换页面就收掉浮层那张卡：它挂在布局层，不跟着页面销毁，留着会飘到新页面上。
// 同页切 tab 只有 query 变、path 不变，不收；详情页常驻卡跟页面走，也不在这里收。
watch(
  () => route.path,
  () => {
    // 换页面了：新页面重新定位一次
    lockedSpot = null;
    if (resumeHintState.open && !resumeHintState.persistent) dismissResumeHint();
  },
);

// 卡片站定之后才播牌堆那套逐张招手的入场动画（牌堆挂载时还是隐藏的，动画看不见）
watch(ready, (value) => {
  if (!value) return;
  // 第一次上屏就把落点定死，后面无论怎么折腾都不再换位置
  lockChosen();
  deckRef.value?.replay();
});

onBeforeUnmount(stopFollow);

/** 牌堆要的数据形状；第二行文案与搜索页那张卡同一套 */
const deckEntries = computed<ResumeEntryCard[]>(() =>
  resumeHintState.cards.map((card) => {
    const where = formatDuration(card.recordPosition);
    return {
      key: card.key,
      kind: card.kind,
      id: card.scopeId,
      kindLabel: card.kindLabel,
      name: card.scopeName || card.kindLabel,
      cover: card.cover,
      updatedAt: 0,
      hint: card.recordTitle ? `${card.recordTitle} · ${where}` : `上次听到 ${where}`,
    };
  }),
);

/**
 * 点卡：一律先发一条续播请求，再由落地页自己定位（详情页里就就地定位）。
 * - 详情页里那几张常驻卡：就地续播；
 * - 播放时贴出来的卡：跳到对应详情页接着听（专辑按有无声分两种）。
 */
const openCard = async (entry: ResumeEntryCard) => {
  const card: ResumeHintCard | undefined = resumeHintState.cards.find(
    (item) => item.key === entry.key,
  );
  if (!card) return;
  requestResumeHintPlay(card.key);
  const token = resumeHintRequest.token;
  dismissResumeHint();
  if (resumeHintState.persistent) {
    // 常驻卡不跳页：页面在这段时间里认领了请求才算定位开始，没人认领就是没起播
    window.setTimeout(() => {
      if (resumeHintRequest.consumed !== token) {
        toastStore.warning(RESUME_LOCATE_FAILED_TEXT);
      }
    }, PERSISTENT_SETTLE_MS);
    return;
  }
  const id = String(card.scopeId);
  let reached = false;
  if (card.kind === 'artist') {
    reached = await navigateResumeTarget(
      router,
      { name: 'artist-detail', params: { id } },
      'artist-detail',
      id,
    );
  } else if (card.kind === 'playlist') {
    reached = await navigateResumeTarget(
      router,
      { name: 'playlist-detail', params: { id } },
      'playlist-detail',
      id,
    );
  } else {
    reached = await navigateResumeTarget(
      router,
      {
        name: 'album-detail',
        params: { id },
        query: card.kind === 'audiobook' ? { category: '2' } : {},
      },
      'album-detail',
      id,
    );
  }
  if (!reached) toastStore.warning(RESUME_LOCATE_FAILED_TEXT);
};

/** 右键删一张：记录从续播桶里摘掉，牌堆里剩下的继续摆着 */
const removeCard = (entry: ResumeEntryCard) => {
  playerStore.forgetResumeScope(entry.kind, entry.id);
  dropResumeHintCard(entry.key);
  toastStore.actionCompleted('已移除续播记录');
};

// 竖列表展开着的时候不能让展示计时（10 秒）把它关掉；壳也要让路给列表
const onListChange = (open: boolean) => {
  listExpanded.value = open;
  setResumeHintHeld(open);
};
</script>

<template>
  <Teleport to="body">
    <Transition name="resume-hint">
      <div
        v-if="resumeHintState.open"
        :key="resumeHintState.token"
        ref="cardEl"
        class="resume-hint no-drag"
        :class="{ 'is-ready': ready, 'is-list': listExpanded }"
        :style="{
          left: left + 'px',
          top: top + 'px',
          width: deckWidth + 'px',
          height: DECK_HEIGHT + 'px',
          '--spread': spread + 'px',
        }"
        role="status"
      >
        <!-- 一摞卡就是搜索页那一摞：叠放、滚轮换序、单击打开、双击展开、右键删除全在 ResumeDeck 里 -->
        <ResumeDeck
          ref="deckRef"
          :entries="deckEntries"
          :deletable="!resumeHintState.persistent"
          :card-width="CARD_WIDTH"
          :fan-step="FAN_STEP"
          @open="openCard"
          @remove="removeCard"
          @list-change="onListChange"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@reference "@/style.css";

/* 定位壳：卡片长什么样、怎么叠全在 ResumeDeck 里，这里只管贴在哪 */
.resume-hint {
  position: fixed;
  z-index: 9998;
}

/* 位置量准之前先藏在原地量：卡片一出现就该在最终位置，不能先出来再挪 */
.resume-hint:not(.is-ready) {
  visibility: hidden;
}

/*
 * 竖列表展开着：列表是另一层（fixed）画出来的，壳这一层的框正好压在列表第一行上，
 * 所以这时壳整个不接指针，右键/左键都落到列表本身上。
 */
.resume-hint.is-list {
  pointer-events: none;
}

.resume-hint.is-list::after {
  animation: none;
  opacity: 0;
}

/* 牌堆那一套是给搜索页的横排位置写的，浮层里不需要撑满、也不需要右边距 */
.resume-hint :deep(.resume-deck-wrap) {
  display: block;
  flex: none;
}

.resume-hint :deep(.resume-deck) {
  margin-right: 0;
}

/* 收起来时整摞一起淡出 */
.resume-hint-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}

.resume-hint-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.99);
}

/*
 * 高亮：盖在最上面那张卡上的白色薄光 + 边缘更亮。
 * 等牌堆逐张招完（560ms）才亮，约 0.8 秒淡回；用 forwards 而不是 both，
 * 延迟那段时间不能提前套用 0% 关键帧。
 */
.resume-hint::after {
  content: '';
  position: absolute;
  top: 7px;
  left: var(--spread, 0px);
  z-index: 50;
  width: 300px;
  height: 52px;
  border-radius: 10px;
  pointer-events: none;
  background: rgb(255 255 255 / 10%);
  box-shadow:
    inset 0 0 0 1.5px rgb(255 255 255 / 85%),
    inset 0 0 18px rgb(255 255 255 / 22%);
  opacity: 0;
}

.resume-hint.is-ready::after {
  animation: resume-hint-glow 820ms ease-out 560ms 1 forwards;
}

@keyframes resume-hint-glow {
  0% {
    opacity: 0;
  }

  15% {
    opacity: 1;
  }

  55% {
    opacity: 0.62;
  }

  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .resume-hint.is-ready::after {
    animation: none;
  }
}
</style>
