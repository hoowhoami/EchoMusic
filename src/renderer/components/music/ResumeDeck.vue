<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ResumeCardTile from '@/components/music/ResumeCardTile.vue';
import type { ResumeEntryCard } from '@/views/search/resumeCard';

/**
 * 续播卡牌堆：搜索页标题旁边那一摞，和播放时浮出来的提示卡共用这一个组件，
 * 所以「叠放 / 滚轮换序 / 单击打开 / 双击展开 / 右键删除」只有一套实现。
 */
const props = defineProps<{
  /** 卡片数据，顺序就是叠放顺序（新的在前） */
  entries?: ResumeEntryCard[];
  /** 右键能不能删：详情页那张常驻卡不许删 */
  deletable?: boolean;
  /** 页面滚动时整摞钉住不动（搜索页用，浮层本来就不动） */
  pinOnScroll?: boolean;
  /** 固定卡宽：浮层要一个确定尺寸，不跟着容器量 */
  cardWidth?: number;
  /** 固定错开量：同上 */
  fanStep?: number;
  /** 换一批数据时复位指针（搜索页传关键词） */
  resetKey?: string;
}>();

const emit = defineEmits<{
  open: [entry: ResumeEntryCard];
  remove: [entry: ResumeEntryCard];
  /** 竖列表展开/收起：浮层拿它暂停自动收起 */
  'list-change': [open: boolean];
}>();

// 横向平铺再层叠：最左边一张完整，其余往右错开一小段，只露出纸边
const CARD_WIDTH = 300;
const DECK_MARGIN = 24;
const MIN_FAN_STEP = 10;
const MAX_FAN_STEP = 46;
const FAN_ANGLE = 1.6;
const CARD_HEIGHT = 52;
const DECK_HEIGHT = CARD_HEIGHT + 14;

// 竖列表：一格 = 卡高 + 行距；行数不再设上限，有几条铺几条
const LIST_ROW_HEIGHT = CARD_HEIGHT;
const LIST_ROW_GAP = 6;
const LIST_ROW_STEP = LIST_ROW_HEIGHT + LIST_ROW_GAP;
const LIST_SLIDE = 21; // 竖排滚轮：每张卡向右推开的幅度（原 14 加 0.5 倍）
const LIST_SLIDE_STAGGER = 42;
const LIST_SLIDE_DURATION = 380;
const FAN_SWING = 3.2; // 卡叠态：招财猫招手那一下的摆幅（度）
const FAN_SWING_STAGGER = 48; // 逐张摆开的间隔（ms）
const FAN_SWING_DURATION = 560; // 逐张推开的间隔（ms），像划过琴键

// 动画错峰只铺前几层：后面的卡不再继续累加延迟，避免长列表末尾等太久
const STAGGER_STEPS = 6;

// 卡叠里最多露 7 张；展开成竖排也只有这 7 张，滚轮换的是它们各自的内容（和卡叠翻页同一套）
const LIST_MAX_ROWS = 7;

// 卡片从卡叠里的原位飘到自己格子：320ms，每张再错开 48ms；全部落位之后再“形成窗口”
const FLY_DURATION = 320;
const FLY_STAGGER = 48;
const FLY_EASING = 'cubic-bezier(0.22, 0.86, 0.3, 1)';
const FORM_HOLD = 80;
const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 删除后补位：被删位置之后的卡片内容从下一格升上来
const FILL_EASE = 'cubic-bezier(0.22, 0.9, 0.24, 1)';
const FILL_DURATION = 320;
const FILL_STAGGER = 56;
// 末位补进一张新卡：卡叠态绕右下角摆进来，竖排从下往上翻进来
const ARRIVE_DURATION = 420;
// 碎片飞散的时长与数量
const SHATTER_LIFE = 760;
const SHATTER_SHARDS = 96;
// 先让卡片本体散掉再写回数据，避免补位那一瞬间看到「同一张卡换了名字」
const SHATTER_COMMIT_DELAY = 150;

const list = computed(() => props.entries ?? []);

// cursor = 最上面那张在 list 里的下标；list 已按时间倒序（新的在前）
const cursor = ref(0);
const cursorKey = ref('');

// 集合内容刷新（播放进度、新登记）时用 key 找回原来那张，找不到才回到第一张
watch(
  () => list.value.map((entry) => entry.key).join('|'),
  () => {
    const index = cursorKey.value
      ? list.value.findIndex((entry) => entry.key === cursorKey.value)
      : -1;
    cursor.value = index >= 0 ? index : 0;
    cursorKey.value = list.value[cursor.value]?.key ?? '';
  },
  { immediate: true },
);

// 从"最前面那张"开始环绕一圈：卡叠只取前 deckCount 张，列表铺全部
const ring = computed(() => {
  const total = list.value.length;
  if (total === 0) return [];
  const start = cursor.value % total;
  return Array.from({ length: total }, (_, offset) => list.value[(start + offset) % total]!);
});

// 卡叠里最多 7 张（这些都是真实卡片节点，展开时由它们飞进列表的前 7 行）
const deckCount = computed(() => Math.max(1, Math.min(LIST_MAX_ROWS, list.value.length)));

const ordered = computed(() => ring.value.slice(0, deckCount.value));

// 剩余的横向空间全部用上：9 张铺开时该错开多少就错开多少，不硬编码挤在一起
const deckWrapRef = ref<HTMLElement | null>(null);
const deckElRef = ref<HTMLElement | null>(null);

// 卡叠/列表里所有真实卡片（展开时就是这些节点自己飞进列表）
const CARD_SELECTOR = 'button.resume-card';
const deckCards = () => {
  const deck = deckElRef.value;
  if (!deck) return [] as HTMLElement[];
  return Array.from(deck.querySelectorAll<HTMLElement>(CARD_SELECTOR));
};

const wrapWidth = ref(0);
let wrapObserver: ResizeObserver | null = null;

watch(deckWrapRef, (element) => {
  wrapObserver?.disconnect();
  wrapObserver = null;
  if (!element) return;
  const measure = () => {
    wrapWidth.value = element.clientWidth;
  };
  measure();
  wrapObserver = new ResizeObserver(measure);
  wrapObserver.observe(element);
});

// 卡片宽度：不超过设计宽度，窄窗口就跟着缩
const cardWidth = computed(() =>
  props.cardWidth
    ? props.cardWidth
    : Math.max(120, Math.min(CARD_WIDTH, wrapWidth.value || CARD_WIDTH)),
);

// 剩余的横向空间平均分给每张错开的卡，夹在最小/最大错开量之间
const fanStep = computed(() => {
  const count = deckCount.value;
  if (count <= 1) return 0;
  if (props.fanStep) return props.fanStep;
  const room = Math.max(0, (wrapWidth.value || CARD_WIDTH) - DECK_MARGIN - cardWidth.value);
  return Math.max(MIN_FAN_STEP, Math.min(MAX_FAN_STEP, room / (count - 1)));
});

const deckWidth = computed(
  () => cardWidth.value + Math.max(0, deckCount.value - 1) * fanStep.value,
);

// 卡叠的轻微夹角：奇偶交替，最前面那张永远是正的
const fanRotate = (index: number) => (index === 0 ? 0 : index % 2 === 1 ? -FAN_ANGLE : FAN_ANGLE);

/* ---------------- 右键删除区：状态 ---------------- */
// 同一时刻只有一张卡处于「已唤出」，null 表示都没开
const revealedKey = ref<string | null>(null);
// 正在播粉碎动画的那张，挡住连点
const deletingKey = ref<string | null>(null);

const FALLBACK_PALETTE = [
  'rgba(244, 244, 248, 0.92)',
  'rgba(200, 200, 208, 0.9)',
  'rgba(150, 150, 160, 0.86)',
  'rgba(96, 96, 104, 0.8)',
  'rgba(229, 72, 77, 0.9)',
];
const paletteCache = new Map<string, string[]>();

/** 碎片用封面自己的颜色；取不到像素（跨域 / 无封面）就退回中性灰加一点红 */
const loadPalette = (entry: ResumeEntryCard) => {
  const url = entry.cover;
  if (!url || paletteCache.has(url)) return;
  paletteCache.set(url, FALLBACK_PALETTE);
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    try {
      const size = 14;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0, size, size);
      const data = context.getImageData(0, 0, size, size).data;
      const colors: string[] = [];
      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3] ?? 0;
        if (alpha < 48) continue;
        colors.push(
          `rgba(${data[index]}, ${data[index + 1]}, ${data[index + 2]}, ${(alpha / 255).toFixed(2)})`,
        );
      }
      if (colors.length) paletteCache.set(url, colors);
    } catch {
      /* 跨域取不到像素，保留兜底色 */
    }
  };
  image.onerror = () => {
    /* 封面加载失败也用兜底色 */
  };
  image.src = url;
};

/** 卡片碎成碎片飘走：canvas 盖在卡片原位置，粒子带重力下坠，结束后自动移除 */
const shatterCard = (card: HTMLElement, entry: ResumeEntryCard) => {
  if (reduceMotion) return;
  const rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;pointer-events:none;z-index:500;`;
  document.body.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) {
    canvas.remove();
    return;
  }
  context.scale(dpr, dpr);
  const palette = paletteCache.get(entry.cover) ?? FALLBACK_PALETTE;
  const shards = Array.from({ length: SHATTER_SHARDS }, () => {
    const x = Math.random() * rect.width;
    const y = Math.random() * rect.height;
    return {
      x,
      y,
      vx: (x - rect.width / 2) * 1.8 + (Math.random() - 0.5) * 150,
      vy: -70 - Math.random() * 210,
      size: 1.4 + Math.random() * 4.2,
      rot: Math.random() * Math.PI * 2,
      turn: (Math.random() - 0.5) * 14,
      color: palette[(Math.random() * palette.length) | 0] ?? FALLBACK_PALETTE[0]!,
      ttl: SHATTER_LIFE * (0.62 + Math.random() * 0.38),
    };
  });
  const started = performance.now();
  let last = started;
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const elapsed = now - started;
    context.clearRect(0, 0, rect.width, rect.height);
    for (const shard of shards) {
      shard.vy += 1400 * dt;
      shard.x += shard.vx * dt;
      shard.y += shard.vy * dt;
      shard.rot += shard.turn * dt;
      const alpha = Math.max(0, 1 - elapsed / shard.ttl);
      if (alpha <= 0) continue;
      context.save();
      context.globalAlpha = alpha;
      context.translate(shard.x, shard.y);
      context.rotate(shard.rot);
      context.fillStyle = shard.color;
      context.fillRect(-shard.size / 2, -shard.size / 2, shard.size, shard.size * 0.78);
      context.restore();
    }
    if (elapsed < SHATTER_LIFE) window.requestAnimationFrame(tick);
    else canvas.remove();
  };
  window.requestAnimationFrame(tick);
};

/** 卡叠态只有最上面那张能唤出；竖排里每一行都能唤出 */
const canReveal = (index: number) => listOpen.value || index === 0;

const onCardContextMenu = (index: number, entry: ResumeEntryCard) => {
  if (!props.deletable) return;
  clearPendingClick();
  loadPalette(entry);
  if (!canReveal(index)) return;
  // 右键同一张 = 还原；右键另一张 = 前一张先还原
  revealedKey.value = revealedKey.value === entry.key ? null : entry.key;
};

// 点在卡片之外：删除区收起（列表态仍沿用原来的「点空白收起列表」）
const onRevealOutside = (event: PointerEvent) => {
  const target = event.target as Element | null;
  if (target && target.closest(CARD_SELECTOR)) return;
  revealedKey.value = null;
};

watch(revealedKey, (key) => {
  document.removeEventListener('pointerdown', onRevealOutside, true);
  if (key !== null) document.addEventListener('pointerdown', onRevealOutside, true);
});

/** 删一条续播记录：本体碎掉 → 写回数据 → 其余卡片补位、末位补新卡 */
const removeCard = async (index: number, entry: ResumeEntryCard) => {
  if (deletingKey.value) return;
  revealedKey.value = null;
  clearPendingClick();
  const listMode = listOpen.value;
  // 还有没露出来的记录：删完这一张，最后一个格位会有新卡补进来
  const overflow = list.value.length > ordered.value.length;
  const card = deckCards()[index];
  deletingKey.value = entry.key;
  if (card) shatterCard(card, entry);
  await new Promise<void>((resolve) =>
    window.setTimeout(resolve, reduceMotion ? 0 : SHATTER_COMMIT_DELAY),
  );
  emit('remove', entry);
  await nextTick();
  fillAfterDelete(index, listMode, overflow);
  deletingKey.value = null;
};

/** 补位：被删位置之后的卡片内容从下一格升上来，末位若补进新卡就翻进来 */
const fillAfterDelete = (fromIndex: number, listMode: boolean, overflow: boolean) => {
  if (reduceMotion) return;
  const cards = deckCards();
  if (listMode) {
    cards.slice(fromIndex).forEach((card, offset) => {
      const inner = card.querySelector<HTMLElement>('.resume-card-inner');
      if (!inner) return;
      inner.animate(
        [
          { transform: `translate3d(0, ${LIST_ROW_STEP}px, 0)`, opacity: 0.35 },
          { transform: 'translate3d(0, 0, 0)', opacity: 1 },
        ],
        {
          duration: FILL_DURATION,
          delay: Math.min(offset, STAGGER_STEPS) * FILL_STAGGER,
          easing: FILL_EASE,
          // 用 backwards：延迟期间保持起始态，播完立刻交还给 CSS（否则会锁死唤出用的 transform）
          fill: 'backwards',
        },
      );
    });
  }
  if (!overflow) return;
  const last = cards[cards.length - 1];
  if (!last) return;
  last.animate(
    listMode
      ? [
          { transform: 'perspective(520px) rotateX(-72deg)', opacity: 0 },
          { transform: 'perspective(520px) rotateX(0deg)', opacity: 1 },
        ]
      : [
          { transform: 'rotate(-9deg)', opacity: 0 },
          { transform: `rotate(${fanRotate(cards.length - 1)}deg)`, opacity: 1 },
        ],
    { duration: ARRIVE_DURATION, easing: FILL_EASE, fill: 'backwards' },
  );
};

// 展开态：双击面上那张之后，同一批卡片在“面上那张卡”原来的落点上排成竖列
const listOpen = ref(false);
const panelFormed = ref(false);
const openOrigin = ref({ top: 0, left: 0 });

/*
 * 牌堆出现的动画：卡片有增、有删、有换序时，逐张「招一下」再定住 ——
 * 和滑滚轮那一下是同一组关键帧（fanSwing），所以看起来是同一个动作被点了一下。
 * 用 WAAPI 而不是 CSS 关键帧：每张卡自己的 angle 写在 transform 里，
 * 静态关键帧会把那个夹角抹掉。
 */
const deckEnterAnims: Animation[] = [];
let deckEnterTimer: ReturnType<typeof setTimeout> | null = null;
const playDeckEnter = () => {
  if (deckEnterTimer) {
    clearTimeout(deckEnterTimer);
    deckEnterTimer = null;
  }
  if (reduceMotion) return;
  deckEnterTimer = setTimeout(() => {
    deckEnterTimer = null;
    while (deckEnterAnims.length) deckEnterAnims.pop()?.cancel();
    const cards = deckCards();
    if (!cards.length) return;
    cards.forEach((card, index) => {
      const tilt = listOpen.value ? 0 : fanRotate(index);
      const frame = (offset: number, deg: number, opacity: number, easing: string) => ({
        opacity,
        transform: `rotate(${tilt}deg) rotate(${deg}deg)`,
        transformOrigin: '100% 100%',
        offset,
        easing,
      });
      deckEnterAnims.push(
        card.animate(
          [
            frame(0, 0, 0, 'ease-out'),
            frame(0.18, 0, 1, 'cubic-bezier(0.3, 0.9, 0.35, 1)'),
            frame(0.36, -FAN_SWING, 1, 'cubic-bezier(0.35, 0.9, 0.4, 1)'),
            frame(0.64, FAN_SWING * 0.22, 1, 'cubic-bezier(0.3, 0.9, 0.38, 1)'),
            frame(0.85, -FAN_SWING * 0.07, 1, 'cubic-bezier(0.2, 0.9, 0.3, 1)'),
            frame(1, 0, 1, 'ease-out'),
          ],
          {
            duration: FAN_SWING_DURATION,
            delay: Math.min(index, STAGGER_STEPS) * FAN_SWING_STAGGER,
            fill: 'backwards',
          },
        ),
      );
    });
  }, 20);
};
// 增、删、换序都重播：只要这摞卡的顺序变了就重新招一遍
watch(
  () => ordered.value.map((entry) => entry.key).join('|'),
  () => playDeckEnter(),
  { immediate: true },
);
onBeforeUnmount(() => {
  if (deckEnterTimer) clearTimeout(deckEnterTimer);
  while (deckEnterAnims.length) deckEnterAnims.pop()?.cancel();
});

// 单击跳转要等一个窗口，双击才能把这个待执行的跳转取消掉。
// 取 350ms：介于「点了就走」和系统双击间隔（Windows 默认 500ms）之间，
// 慢一点的双击不至于掉成两次单击，单击也不至于明显发木。
const CLICK_WINDOW = 350;
// 浏览器只在同一个元素上发 dblclick，卡片一挪位就发不出来；
// 这里自己按「同一张卡 + 时间窗」再判一次，双击才不会漏成单击。
let lastPickAt = 0;
let lastPickKey = '';
const takeRepeatPick = (key: string): boolean => {
  const now = performance.now();
  const repeat = key !== '' && key === lastPickKey && now - lastPickAt <= CLICK_WINDOW;
  if (repeat) {
    lastPickAt = 0;
    lastPickKey = '';
  } else {
    lastPickAt = now;
    lastPickKey = key;
  }
  return repeat;
};
let clickTimer: ReturnType<typeof setTimeout> | null = null;
const clearPendingClick = () => {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
};

let formTimer: ReturnType<typeof setTimeout> | null = null;
const clearFormTimer = () => {
  if (formTimer) {
    clearTimeout(formTimer);
    formTimer = null;
  }
};

// 展开前记下每张卡在卡叠里的位置（FLIP 的起点），以及整块卡叠要落的点
let startRects: { left: number; top: number }[] = [];
const readOrigin = () => {
  const cards = deckCards();
  startRects = cards.map((card) => {
    const rect = card.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });
  const first = cards[0];
  if (first) {
    const rect = first.getBoundingClientRect();
    openOrigin.value = { top: rect.top, left: rect.left };
  }
};

const flyAnims: Animation[] = [];
const cancelFlies = () => {
  while (flyAnims.length) {
    flyAnims.pop()?.cancel();
  }
};

// 展开态整块卡叠脱离文档流（fixed），高度 = 7 行固定，不滚动
const deckStyle = computed(() => {
  if (!listOpen.value) return { width: `${deckWidth.value}px`, height: `${DECK_HEIGHT}px` };
  const height = Math.max(0, deckCount.value - 1) * LIST_ROW_STEP + LIST_ROW_HEIGHT;
  return {
    top: `${openOrigin.value.top}px`,
    left: `${openOrigin.value.left}px`,
    width: `${cardWidth.value}px`,
    height: `${height}px`,
  };
});

/*
 * 卡叠不跟页面上下动：页面一滚，整块挪到 body 上、用 fixed 钉在它原来的落点，
 * 之后不管哪一层容器在滚，它都停在那儿。
 * 不用「留在文档流里加反向位移」——外层有 isolation / 裁切时，加多少 z-index
 * 都会被吸顶出来的工具栏盖住。
 */
const deckPinned = ref(false);
// 没滚的时候它在版心里的落点，滚起来以后就钉在这儿
const restLeft = ref(0);
const restTop = ref(0);
const pinLeft = ref(0);
const pinTop = ref(0);

const measureRestSpot = () => {
  const deck = deckElRef.value;
  if (!deck || deckPinned.value) return;
  const rect = deck.getBoundingClientRect();
  if (!rect.width) return;
  restLeft.value = Math.round(rect.left);
  restTop.value = Math.round(rect.top);
};
// 卡叠外面可能不止一层滚动容器（页面一个、里面的列表一个），
// 逐个记下它们此刻的 scrollTop，之后看总位移判断是不是滚起来了。
let deckScrollers: { el: HTMLElement; base: number }[] = [];

const collectDeckScrollers = () => {
  deckScrollers = [];
  let node = deckWrapRef.value?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (
      style.overflowY === 'auto' ||
      style.overflowY === 'scroll' ||
      style.overflowY === 'overlay'
    ) {
      deckScrollers.push({ el: node, base: node.scrollTop });
    }
    node = node.parentElement;
  }
};

const applyDeckPin = () => {
  if (!props.pinOnScroll) return;
  const deck = deckElRef.value;
  if (listOpen.value || !deck) {
    deckPinned.value = false;
    return;
  }
  let sum = 0;
  for (const item of deckScrollers) {
    if (item.el.isConnected) sum += Math.abs(item.el.scrollTop - item.base);
  }
  if (!sum) {
    deckPinned.value = false;
    measureRestSpot();
    return;
  }
  if (!deckPinned.value) {
    // 用之前量好的原位当钉子；此刻它已经跟着滚走了，现量是量不准的
    pinLeft.value = restLeft.value;
    pinTop.value = restTop.value;
    deckPinned.value = true;
  }
};
function onDeckScroll() {
  if (!props.pinOnScroll) return;
  if (listOpen.value || !deckElRef.value) {
    deckPinned.value = false;
    return;
  }
  if (!deckScrollers.length) collectDeckScrollers();
  applyDeckPin();
}

const syncDeckScroll = () => {
  // 只重新记一遍滚动基准；钉住状态别在这儿清，Teleport 搬动节点时 ref 会晃一下
  collectDeckScrollers();
  measureRestSpot();
};

// scroll 不冒泡，但 window 的捕获阶段能收到任何容器的滚动
if (props.pinOnScroll)
  window.addEventListener('scroll', onDeckScroll, { capture: true, passive: true });
watch(
  deckElRef,
  (el) => {
    if (el) syncDeckScroll();
  },
  { flush: 'post' },
);
watch(listOpen, () => void nextTick(syncDeckScroll));
// 窗口尺寸变了，原来的落点就不作数了：先退回文档流，重量一遍再钉
const onDeckResize = () => {
  deckPinned.value = false;
  void nextTick(() => {
    syncDeckScroll();
    onDeckScroll();
  });
};
if (props.pinOnScroll) window.addEventListener('resize', onDeckResize);
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onDeckScroll, true);
  window.removeEventListener('resize', onDeckResize);
});

// 钉住时整块搬到 body 上、用 fixed 停在原位，层级给到页面之上
const deckPinStyle = computed(() =>
  props.pinOnScroll && deckPinned.value && !listOpen.value
    ? {
        position: 'fixed' as const,
        left: `${pinLeft.value}px`,
        top: `${pinTop.value}px`,
        width: `${deckWidth.value}px`,
        height: `${DECK_HEIGHT}px`,
        margin: '0',
        zIndex: 400,
      }
    : undefined,
);

const cardStyle = (index: number) => {
  const count = ordered.value.length;
  const width = `${cardWidth.value}px`;
  const zIndex = count - index;
  if (listOpen.value) {
    return {
      left: '0px',
      top: `${index * LIST_ROW_STEP}px`,
      width,
      zIndex,
      transform: 'none',
      transformOrigin: '50% 50%',
      transition: reduceMotion
        ? 'none'
        : 'background 320ms ease, border-color 320ms ease, box-shadow 320ms ease',
    };
  }
  const behind = count - 1 - index;
  return {
    left: `${behind * fanStep.value}px`,
    width,
    zIndex,
    transform: index === 0 ? 'none' : `rotate(${fanRotate(index)}deg)`,
    // 出现动画按"第几张"错峰，最前面那张先抖，后面的依次跟上
    '--i': String(Math.min(index, STAGGER_STEPS)),
    // 和 fanSwing 的关键帧用同一个原点，动画收尾时才不会跳一下
    transformOrigin: '100% 100%',
  };
};

// 只移动“哪张在最前”这个指针：list 本身顺序（新的在前）不动，所以只是临时置前
const moveCursorTo = (index: number) => {
  const total = list.value.length;
  if (total <= 1) return;
  const next = ((index % total) + total) % total;
  if (next === cursor.value) return;
  cursor.value = next;
  cursorKey.value = list.value[next]?.key ?? '';
};

const moveCursor = (step: number) => moveCursorTo(cursor.value + step);

const pickCard = (index: number) => {
  // 删除区还开着：这一下点击只负责还原，不跳转、不展开
  if (revealedKey.value !== null) {
    revealedKey.value = null;
    lastPickAt = 0;
    lastPickKey = '';
    return;
  }
  const shown = ordered.value.length;
  if (shown === 0) return;
  const entry = ordered.value[index];
  if (!entry) return;
  // 同一张卡在双击窗口里被点了第二下：当成「展开/收起」，不跳转
  if (takeRepeatPick(entry.key)) {
    if (listOpen.value || index === 0) toggleCardList();
    return;
  }
  // 列表已经展开：点哪一行就打开哪一条；等单击窗过去，
  // 这样双击这一行才能改成“收起”，而不会先跳走
  if (listOpen.value) {
    clearPendingClick();
    clickTimer = setTimeout(() => {
      clickTimer = null;
      listOpen.value = false;
      emit('open', entry);
    }, CLICK_WINDOW);
    return;
  }
  if (index === 0) {
    const top = ordered.value[0];
    if (!top) return;
    clearPendingClick();
    clickTimer = setTimeout(() => {
      clickTimer = null;
      listOpen.value = false;
      emit('open', top);
    }, CLICK_WINDOW);
    return;
  }
  // 被遮住的卡：点一下把这张临时挪到最前（只动 cursor，不改 list 顺序、不写回 store）
  moveCursorTo(cursor.value + index);
};

// 竖排里内容换掉之后，卡片自己弹一下（有回弹的缓动，不是平移动画）
const bounceAnims: Animation[] = [];
const bounceCards = (steps: number) => {
  if (reduceMotion || !steps) return;
  while (bounceAnims.length) bounceAnims.pop()?.cancel();
  const cards = deckCards();
  if (cards.length < 2) return;
  const direction: 1 | -1 = steps > 0 ? 1 : -1;
  // 像手指划过钢琴琴键：顺着滚动方向（向下滚=上面那张先动，向上滚=下面那张先动）
  // 每张都往右推，主位移之后是一串越来越小的回摆，阻尼全部收在末尾
  const order = direction === 1 ? cards : [...cards].reverse();
  const push = LIST_SLIDE * Math.min(3, Math.abs(steps));
  order.forEach((card, step) => {
    bounceAnims.push(
      card.animate(
        [
          { transform: 'translate3d(0, 0, 0)', easing: 'cubic-bezier(0.25, 0.9, 0.3, 1)' },
          {
            transform: `translate3d(${push}px, 0, 0)`,
            offset: 0.3,
            easing: 'cubic-bezier(0.3, 0.9, 0.35, 1)',
          },
          {
            transform: `translate3d(${-push * 0.22}px, 0, 0)`,
            offset: 0.62,
            easing: 'cubic-bezier(0.3, 0.9, 0.38, 1)',
          },
          {
            transform: `translate3d(${push * 0.07}px, 0, 0)`,
            offset: 0.84,
            easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
          },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        {
          duration: LIST_SLIDE_DURATION,
          delay: step * LIST_SLIDE_STAGGER,
          fill: 'none',
        },
      ),
    );
  });
};

// 卡叠态滚轮：逐张像招财猫那只手一样招一下——绕各自右下角摆动，末尾带阻尼
const fanAnims: Animation[] = [];
const fanSwing = (steps: number) => {
  if (reduceMotion || !steps) return;
  while (fanAnims.length) fanAnims.pop()?.cancel();
  const cards = deckCards();
  if (cards.length < 2) return;
  const direction: 1 | -1 = steps > 0 ? 1 : -1;
  const order = direction === 1 ? cards : [...cards].reverse();
  const delayOf = new Map<Element, number>();
  order.forEach((card, step) => delayOf.set(card, step * FAN_SWING_STAGGER));
  // 方向固定，滚轮来回都是往同一侧招；steps 只决定逐张的顺序
  const amp = -FAN_SWING * Math.min(3, Math.abs(steps));
  cards.forEach((card, index) => {
    // 卡片自己的角度必须原样写进关键帧，否则 WAAPI 会把 inline 的倾斜抹掉
    const tilt = index === 0 ? 0 : fanRotate(index);
    fanAnims.push(
      card.animate(
        [
          {
            transform: `rotate(${tilt}deg) rotate(0deg)`,
            transformOrigin: '100% 100%',
            easing: 'cubic-bezier(0.3, 0.9, 0.35, 1)',
          },
          {
            transform: `rotate(${tilt}deg) rotate(${amp}deg)`,
            transformOrigin: '100% 100%',
            offset: 0.3,
            easing: 'cubic-bezier(0.35, 0.9, 0.4, 1)',
          },
          {
            transform: `rotate(${tilt}deg) rotate(${-amp * 0.22}deg)`,
            transformOrigin: '100% 100%',
            offset: 0.62,
            easing: 'cubic-bezier(0.3, 0.9, 0.38, 1)',
          },
          {
            transform: `rotate(${tilt}deg) rotate(${amp * 0.07}deg)`,
            transformOrigin: '100% 100%',
            offset: 0.84,
            easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
          },
          { transform: `rotate(${tilt}deg) rotate(0deg)`, transformOrigin: '100% 100%' },
        ],
        {
          duration: FAN_SWING_DURATION,
          delay: delayOf.get(card) ?? 0,
          fill: 'none',
        },
      ),
    );
  });
};

// 滚轮档位（卡叠态与竖排共用）：按相邻两格的间隔挑一档，越猛滚每格切换得越多。
// 慢滚 1 格 = 1 张；<120ms 每格 10/8 张；<100ms 10/7 张；<80ms 10/6 张；<60ms 10/5 张。
// 每格的“量”还要按 deltaY 幅度折算：触控板一格会拆成很多小事件，只看间隔会失控。
const WHEEL_TIERS: { gap: number; ratio: number }[] = [
  { gap: 60, ratio: 10 / 5 },
  { gap: 80, ratio: 10 / 6 },
  { gap: 100, ratio: 10 / 7 },
  { gap: 120, ratio: 10 / 8 },
];
/** 一个标准鼠标滚轮刻度的 deltaY，比它小的按比例折算 */
const WHEEL_UNIT_PX = 120;
/** 同一物理刻度会被拆成多个事件，间隔在这之内的合并成一次处理 */
const WHEEL_MERGE_MS = 16;
/** 单次最多跳几张，免得一下轮回一圈 */
const WHEEL_MAX_STEPS = 2;
let wheelAccum = 0;
let lastWheelAt = 0;
let wheelFlushTimer: number | null = null;

const wheelUnit = (delta: number) => Math.max(1 / 3, Math.min(3, Math.abs(delta) / WHEEL_UNIT_PX));

const clearWheel = () => {
  if (wheelFlushTimer !== null) window.clearTimeout(wheelFlushTimer);
  wheelFlushTimer = null;
  wheelAccum = 0;
  lastWheelAt = 0;
};

const flushWheel = () => {
  wheelFlushTimer = null;
  let raw = wheelAccum > 0 ? Math.floor(wheelAccum) : Math.ceil(wheelAccum);
  // 保底一张：只要还有方向，就至少切一张，不出现“滚了没动”
  if (raw === 0 && wheelAccum !== 0) raw = Math.sign(wheelAccum);
  const steps = Math.max(-WHEEL_MAX_STEPS, Math.min(WHEEL_MAX_STEPS, raw));
  if (steps === 0) return;
  wheelAccum -= steps;
  // 零头不许无限累加
  if (Math.abs(wheelAccum) > WHEEL_MAX_STEPS) {
    wheelAccum = Math.sign(wheelAccum) * WHEEL_MAX_STEPS;
  }
  moveCursor(steps);
  if (listOpen.value) {
    void bounceCards(steps);
  } else {
    fanSwing(steps);
  }
};

const onDeckWheel = (event: WheelEvent) => {
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (!delta) return;
  if (ordered.value.length < 2) return;
  event.preventDefault();
  const now = performance.now();
  const gap = now - lastWheelAt;
  const ratio = WHEEL_TIERS.find((tier) => gap < tier.gap)?.ratio ?? 1;
  lastWheelAt = now;
  const amount = Math.sign(delta) * wheelUnit(delta) * ratio;
  // 方向一变就丢掉没攒满的零头，避免“往回滚一下不动”
  if (Math.sign(amount) !== Math.sign(wheelAccum)) wheelAccum = 0;
  wheelAccum += amount;
  if (wheelFlushTimer === null) wheelFlushTimer = window.setTimeout(flushWheel, WHEEL_MERGE_MS);
};

// 双击面上那张：先取消待执行的单击跳转，再决定展开还是收起
const toggleCardList = () => {
  clearPendingClick();
  if (listOpen.value) {
    listOpen.value = false;
    return;
  }
  readOrigin();
  listOpen.value = true;
};

// 浏览器自己的 dblclick 只当兜底：展开/收起已经由 pickCard 的「同一张卡第二下」做过了，
// 这里再 toggle 会和它抵消，所以只取消待执行的单击跳转。
const onCardDblClick = () => {
  clearPendingClick();
  lastPickAt = 0;
  lastPickKey = '';
};

// 点空白：只有点在卡片上才算操作卡片，其余（卡片缝、面板空白、占位）都收起
const onDocumentPointerDown = (event: PointerEvent) => {
  if (!listOpen.value) return;
  const target = event.target as Element | null;
  if (target && target.closest(CARD_SELECTOR)) return;
  clearPendingClick();
  listOpen.value = false;
};

const onDocumentKeydown = (event: KeyboardEvent) => {
  if (!listOpen.value || event.key !== 'Escape') return;
  clearPendingClick();
  listOpen.value = false;
};

// 窗口滚动/缩放就收起，避免面板和卡片错位；列表自己滚不算
const onViewportChange = (event?: Event) => {
  if (!listOpen.value) return;
  const deck = deckElRef.value;
  const target = event?.target as Node | null;
  if (deck && target && deck.contains(target)) return;
  listOpen.value = false;
};

// 换关键词重新搜索：列表收起、指针复位，下次搜索回到默认“新的在前”
watch(
  () => props.resetKey,
  () => {
    clearPendingClick();
    listOpen.value = false;
    cursor.value = 0;
    cursorKey.value = '';
    clearWheel();
  },
);

// 收起前量一遍：每张卡此刻在列表里的位置（飞回卡叠的起点）
const currentCardRects = () =>
  deckCards().map((card) => {
    const rect = card.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  });

// 收起：卡片先回到卡叠的布局，再从各自列表格位飞回扇形原位（和展开是同一套 FLIP，方向相反）
const flyBackFrom = async (prev: { left: number; top: number }[]) => {
  if (reduceMotion || prev.length === 0) return;
  await nextTick();
  deckCards().forEach((card, index) => {
    const before = prev[index];
    if (!before) return;
    const rect = card.getBoundingClientRect();
    const dx = Math.round(before.left - rect.left);
    const dy = Math.round(before.top - rect.top);
    if (dx === 0 && dy === 0) return;
    flyAnims.push(
      card.animate(
        [
          { transform: 'translate3d(' + dx + 'px, ' + dy + 'px, 0) rotate(0deg)' },
          {
            transform:
              index === 0
                ? 'translate3d(0, 0, 0) rotate(0deg)'
                : 'rotate(' + fanRotate(index) + 'deg)',
          },
        ],
        {
          duration: FLY_DURATION,
          delay: Math.min(index, STAGGER_STEPS) * FLY_STAGGER,
          easing: FLY_EASING,
          fill: 'both',
        },
      ),
    );
  });
};

watch(listOpen, async (open) => {
  clearWheel();
  clearFormTimer();
  cancelFlies();
  if (!open) {
    const restingRects = currentCardRects();
    panelFormed.value = false;
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeydown);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
    void flyBackFrom(restingRects);
    return;
  }

  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  panelFormed.value = false;
  const rows = ordered.value.length;
  const formDelay = FLY_DURATION + Math.max(0, rows - 1) * FLY_STAGGER + FORM_HOLD;

  // 先让列表按最终位置排好，再把每张卡从它刚才在卡叠里的位置飞回格子（FLIP）
  await nextTick();

  if (reduceMotion) {
    panelFormed.value = true;
    return;
  }

  const openCards = deckCards();
  openCards.forEach((card, index) => {
    const before = startRects[index];
    if (!before) return;
    const rect = card.getBoundingClientRect();
    const dx = Math.round(before.left - rect.left);
    const dy = Math.round(before.top - rect.top);
    if (dx === 0 && dy === 0) return;
    flyAnims.push(
      card.animate(
        [
          {
            transform: `translate3d(${dx}px, ${dy}px, 0) rotate(${fanRotate(index)}deg)`,
          },
          { transform: 'translate3d(0, 0, 0) rotate(0deg)' },
        ],
        {
          duration: FLY_DURATION,
          // 和收起同一套错峰顺序，只是路径反过来（卡叠原位 → 列表格子）
          delay: Math.min(index, STAGGER_STEPS) * FLY_STAGGER,
          easing: FLY_EASING,
          fill: 'both',
        },
      ),
    );
  });

  formTimer = setTimeout(() => {
    formTimer = null;
    panelFormed.value = true;
  }, formDelay);
});

onBeforeUnmount(() => {
  cancelFlies();
  clearPendingClick();
  document.removeEventListener('pointerdown', onRevealOutside, true);
  wrapObserver?.disconnect();
  wrapObserver = null;
  clearFormTimer();
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});
// 竖列表展开/收起对外的信号
watch(listOpen, (open) => emit('list-change', open));

defineExpose({
  /** 重新播一遍入场动画（浮层等自己站定之后再放） */
  replay: () => playDeckEnter(),
  deckWidth,
});
</script>

<template>
  <div
    ref="deckWrapRef"
    class="resume-deck-wrap"
    :style="listOpen || deckPinned ? { minHeight: `${DECK_HEIGHT}px` } : undefined"
  >
    <Teleport to="body" :disabled="!listOpen && !deckPinned">
      <div
        ref="deckElRef"
        class="resume-deck"
        :class="{
          'is-list': listOpen,
          'is-formed': listOpen && panelFormed,
        }"
        :style="[deckStyle, deckPinStyle]"
        @wheel="onDeckWheel"
        :role="listOpen ? 'listbox' : undefined"
        :aria-label="listOpen ? '上次播放' : undefined"
      >
        <ResumeCardTile
          v-for="(entry, index) in ordered"
          :key="index"
          :class="{ 'is-deleting': deletingKey === entry.key }"
          :style="cardStyle(index)"
          :role="listOpen ? 'option' : undefined"
          :aria-label="
            listOpen
              ? `打开${entry.kindLabel}：${entry.name}`
              : index === 0
                ? `打开${entry.kindLabel}：${entry.name}，双击展开列表`
                : `把${entry.name}置为最前`
          "
          :aria-haspopup="index === 0 ? 'listbox' : undefined"
          :aria-expanded="index === 0 ? listOpen : undefined"
          :name="entry.name"
          :cover="entry.cover"
          :kind-label="entry.kindLabel"
          :hint="entry.hint"
          :open="index === 0 && !listOpen"
          :revealed="revealedKey === entry.key"
          :list-mode="listOpen"
          tooltip
          @click="pickCard(index)"
          @dblclick.prevent="onCardDblClick"
          @contextmenu.prevent="onCardContextMenu(index, entry)"
        >
          <span v-if="deletable" class="resume-card-delete" @click.stop="removeCard(index, entry)"
            >删除</span
          >
        </ResumeCardTile>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.resume-deck-wrap {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  justify-content: flex-start;
}

/* 列表背景保持透明：每一行就是卡片本来的样子（自带圆角、描边与投影），
   不再额外画出窗口底或把卡片做成透明行 */
/* 第 8 行起没有卡叠原位可飞，只在格子里淡入 */
.resume-deck.is-list .resume-card:hover {
  background: var(--surface-4, rgb(255 255 255 / 12%));
  background-image: none;
}

@media (prefers-reduced-motion: reduce) {
  .resume-card {
    transition: none;
  }
}

/* 横向平铺的舞台：后面的卡向左错开并带夹角，形成抽卡的手感 */
.resume-deck {
  position: relative;
  flex: none;
  margin-right: 24px;
  padding: 2px 0;
}

/* 展开态：同一块卡叠就地变成竖列表，固定在“面上那张卡”原来的落点上 */
.resume-deck.is-list {
  position: fixed;
  z-index: 400;
  margin: 0;
  padding: 0;
}

.resume-card {
  /* 删除区参数：内容左移量 / 唤出与收起共用的缓动（同一族，末段阻尼更明显） */
  --resume-reveal-width: 64px;
  --resume-reveal-duration: 340ms;
  --resume-reveal-ease: cubic-bezier(0.2, 1.16, 0.3, 1);
  /* 外观（毛玻璃、圆角、52px 高）都在 ResumeCardTile 里，这里只负责牌堆里的定位与位移过渡 */
  position: absolute;
  top: 7px;
  will-change: left;
  transition:
    left 680ms cubic-bezier(0.22, 0.68, 0.24, 1),
    transform 680ms cubic-bezier(0.22, 0.68, 0.24, 1),
    background 320ms ease,
    box-shadow 320ms ease,
    filter 320ms ease;
}

/* 卡叠里后面的卡片只渲染封面：露出来的那一小条就是它的封面图，文字不露
   （内容层的隐藏与淡入在 ResumeCardTile 里，按 open / list-mode 两个属性走） */
.resume-deck:not(.is-list) .resume-card:not(.is-open) {
  background-image: linear-gradient(rgb(0 0 0 / 22%), rgb(0 0 0 / 22%));
}

/* 鼠标停在最上面那张时，后面叠着的几张虚化，视线只留一张清楚的 */
.resume-deck:has(.resume-card.is-open:hover) .resume-card:not(.is-open) {
  filter: blur(3px) saturate(0.9);
}

.resume-card.is-open {
  background-image: none;
  box-shadow: 0 6px 18px rgb(0 0 0 / 30%);
}

.resume-card.is-open:hover {
  background: var(--surface-4, rgb(255 255 255 / 15%));
}

/* 右沿红底删除区：从右沿外面滑进来，跟内容同一套缓动一起收住 */
.resume-card-delete {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  width: var(--resume-reveal-width);
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #fff;
  background: rgb(229 72 77 / 92%);
  opacity: 0;
  pointer-events: none;
  transform: translate3d(100%, 0, 0);
  transition:
    transform var(--resume-reveal-duration) var(--resume-reveal-ease),
    opacity 180ms ease;
}

.resume-card.is-revealed .resume-card-delete {
  opacity: 1;
  pointer-events: auto;
  transform: translate3d(0, 0, 0);
}

/* 删除中：本体先散掉，粒子接管这一格 */
.resume-card.is-deleting {
  pointer-events: none;
}

.resume-card.is-deleting :deep(.resume-card-inner),
.resume-card.is-deleting .resume-card-delete {
  opacity: 0;
  transition: opacity 120ms linear;
}

@media (prefers-reduced-motion: reduce) {
  .resume-card :deep(.resume-card-inner),
  .resume-card-delete {
    transition: none;
  }
}
</style>
