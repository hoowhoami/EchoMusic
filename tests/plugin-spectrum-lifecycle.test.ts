import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createRenderer, defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { createPluginSpectrumSubscription } from '../src/renderer/plugins/runtime/spectrumSubscription.ts';

const originals = new Map<string, PropertyDescriptor | undefined>();
function globalValue(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

type SubscriptionRecord = {
  pluginId?: string;
  options: unknown;
  paused: boolean;
  disposed: boolean;
  disposedWhilePaused: boolean;
  delivered: number;
};

/** 伪造 window.electron.audioSpectrum，行为对齐 preload 的订阅句柄语义。 */
function setupBridge() {
  const records: SubscriptionRecord[] = [];
  globalValue('window', {
    electron: {
      audioSpectrum: {
        subscribe: (
          options: unknown,
          _func: (frame: unknown) => void,
          meta?: { pluginId?: string },
        ) => {
          const record: SubscriptionRecord = {
            pluginId: meta?.pluginId,
            options,
            paused: false,
            disposed: false,
            disposedWhilePaused: false,
            delivered: 0,
          };
          records.push(record);
          const dispose = () => {
            record.disposed = true;
            record.disposedWhilePaused = record.paused;
          };
          return Object.assign(dispose, {
            setPaused: (paused: boolean) => {
              record.paused = paused;
            },
          });
        },
      },
    },
  });
  return { records };
}

const noopDeps = () => {
  const disposables: Array<() => void> = [];
  return {
    disposables,
    deps: {
      runPluginCallback: (_pluginId: string, _source: string, callback: () => void) => callback(),
      addDisposable: (dispose: () => void) => {
        disposables.push(dispose);
        return dispose;
      },
    },
  };
};

/** 用 Vue 自定义渲染器驱动真实的 KeepAlive 激活/停用。 */
function createHost() {
  const nodeOps = {
    createElement: (tag: string) => ({ tag, children: [] as unknown[] }),
    createText: (text: string) => ({ tag: '#text', text }),
    createComment: (text: string) => ({ tag: '#comment', text }),
    setText: (node: any, text: string) => {
      node.text = text;
    },
    setElementText: (node: any, text: string) => {
      node.text = text;
    },
    insert: (child: any, parent: any, anchor?: any) => {
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index >= 0) parent.children.splice(index, 0, child);
      else parent.children.push(child);
    },
    remove: (child: any) => {
      const parent = child.parent;
      if (parent) {
        const index = parent.children.indexOf(child);
        if (index >= 0) parent.children.splice(index, 1);
        child.parent = null;
      }
    },
    parentNode: (node: any) => node.parent ?? null,
    nextSibling: (node: any) => {
      const siblings = node.parent?.children;
      if (!siblings) return null;
      return siblings[siblings.indexOf(node) + 1] ?? null;
    },
    querySelector: () => null,
    setScopeId: () => {},
    patchProp: () => {},
  };
  const { createApp } = createRenderer(nodeOps as never);
  return createApp;
}

test('pauses delivery while a plugin page is cached by KeepAlive and resumes on re-entry', async () => {
  const { records } = setupBridge();
  const { deps } = noopDeps();
  const createApp = createHost();

  const Child = defineComponent({
    setup() {
      createPluginSpectrumSubscription('demo', { fps: 60 }, () => {}, deps);
      return () => h('span');
    },
  });
  Child.displayName = 'Child';

  const which = ref('a');
  const root = defineComponent({
    setup: () => () =>
      h(KeepAlive, null, { default: () => h(which.value === 'a' ? Child : Other) }),
  });
  const Other = defineComponent({ setup: () => () => h('i') });

  const container: any = { tag: 'root', children: [] };
  createApp(root).mount(container);
  await nextTick();

  assert.equal(records.length, 1, '组件 setup 内应只订阅一次');
  assert.equal(records[0].paused, false, '可见时应正常投递');

  // 切走：组件被 KeepAlive 缓存，不应再收到帧，但订阅必须保留。
  which.value = 'b';
  await nextTick();
  assert.equal(records[0].paused, true, '页面不可见时应暂停投递');
  assert.equal(records[0].disposed, false, '缓存不等于卸载，订阅应保留以便恢复');

  // 切回：应恢复投递。
  which.value = 'a';
  await nextTick();
  assert.equal(records[0].paused, false, '重新进入页面应恢复投递');
  assert.equal(records.length, 1, '恢复不应产生重复订阅');
});

test('unsubscribes for real when the owning component unmounts', async () => {
  const { records } = setupBridge();
  const { deps } = noopDeps();
  const createApp = createHost();

  const Child = defineComponent({
    setup() {
      createPluginSpectrumSubscription('demo', { fps: 30 }, () => {}, deps);
      return () => h('span');
    },
  });
  Child.displayName = 'Child';

  const which = ref('a');
  const Other = defineComponent({ setup: () => () => h('i') });
  const root = defineComponent({
    setup: () => () =>
      h(KeepAlive, null, { default: () => h(which.value === 'a' ? Child : Other) }),
  });

  const container: any = { tag: 'root', children: [] };
  const app = createApp(root);
  app.mount(container);
  await nextTick();
  assert.equal(records[0].disposed, false);

  app.unmount();
  await nextTick();
  assert.equal(records[0].disposed, true, '组件卸载后必须真正退订，不能残留订阅');
});

test('releases the subscription when a plugin lyric skin unmounts via v-if', async () => {
  // 歌词页不是路由也不在 KeepAlive 内，而是 v-if 挂载：关闭歌词页/切换皮肤即真实卸载。
  const { records } = setupBridge();
  const { deps } = noopDeps();
  const createApp = createHost();

  const LyricSkin = defineComponent({
    setup() {
      createPluginSpectrumSubscription('water-lyrics', { fps: 60, binCount: 512 }, () => {}, deps);
      return () => h('div');
    },
  });
  LyricSkin.displayName = 'LyricSkin';

  const open = ref(true);
  const root = defineComponent({
    setup: () => () => (open.value ? h(LyricSkin) : h('div')),
  });

  const container: any = { tag: 'root', children: [] };
  createApp(root).mount(container);
  await nextTick();
  assert.equal(records.length, 1);
  assert.equal(records[0].disposed, false);

  // 关闭歌词页 -> 真实卸载，订阅必须立刻释放。
  open.value = false;
  await nextTick();
  assert.equal(records[0].disposed, true, '歌词页卸载后不得残留频谱订阅');

  // 重新打开应重新订阅，而不是复用已释放的订阅。
  open.value = true;
  await nextTick();
  assert.equal(records.length, 2, '重新打开歌词页应建立新的订阅');
  assert.equal(records[1].disposed, false);
});

test('a module-level subscription is only released on plugin deactivation', async () => {
  const { records } = setupBridge();
  const { deps, disposables } = noopDeps();

  // 不在组件上下文中创建：不应注册组件级钩子，仅走 addDisposable。
  createPluginSpectrumSubscription('demo', { fps: 60 }, () => {}, deps);
  await nextTick();

  assert.equal(records.length, 1);
  assert.equal(records[0].paused, false, '无 document 时视为可见，保持旧行为');
  assert.equal(records[0].disposed, false);

  // 模拟插件停用：宿主反向执行 disposables。
  for (const dispose of disposables.slice().reverse()) dispose();
  assert.equal(records[0].disposed, true, '模块级订阅由插件停用释放');
});

test('a subscription created while the document is hidden starts paused', async () => {
  const { records } = setupBridge();
  const { deps } = noopDeps();

  globalValue('document', {
    visibilityState: 'hidden',
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  createPluginSpectrumSubscription('demo', { fps: 60 }, () => {}, deps);
  await nextTick();

  assert.equal(records.length, 1);
  assert.equal(
    records[0].paused,
    true,
    '在不可见状态下建立的订阅应立即暂停，而不是等下一次可见性变化',
  );
});
