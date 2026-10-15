import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export {showOpenDialogSafely, showSaveDialogSafely, showMessageBoxSafely} from './src/main/ipc/dialogHost';`,
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'dialog-host-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'dh' }));
        b.onResolve({ filter: /^\.\.\/window$/ }, () => ({ path: 'window', namespace: 'dh' }));
        b.onResolve({ filter: /^\.\.\/logger$/ }, () => ({ path: 'logger', namespace: 'dh' }));
        b.onLoad({ filter: /.*/, namespace: 'dh' }, (args) => {
          if (args.path === 'electron')
            return {
              contents: `export const BrowserWindow = { getAllWindows: () => globalThis.__dh.windows() };
export const dialog = {
  showOpenDialog: (...args) => globalThis.__dh.open(...args),
  showSaveDialog: (...args) => globalThis.__dh.save(...args),
  showMessageBox: (...args) => globalThis.__dh.message(...args),
};`,
            };
          if (args.path === 'window')
            return {
              contents: `export const showMainWindow = () => globalThis.__dh.showMainWindow();`,
            };
          return { contents: `export default { info() {}, warn() {} };` };
        });
      },
    },
  ],
});

const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  () => {
    throw new Error('dialogHost 不应有外部依赖');
  },
  module,
  module.exports,
);
const { showOpenDialogSafely, showSaveDialogSafely, showMessageBoxSafely } = module.exports;

const makeWindow = (overrides = {}) => ({
  destroyed: false,
  visible: true,
  minimized: false,
  ...overrides,
  isDestroyed() {
    return this.destroyed;
  },
  isVisible() {
    return this.visible;
  },
  isMinimized() {
    return this.minimized;
  },
});

/**
 * @param windows 当前存活的窗口列表
 * @param onShowMainWindow showMainWindow 的副作用，默认只记录调用
 */
const harness = (windows = [makeWindow()], onShowMainWindow = () => {}) => {
  const calls = { open: [], save: [], message: [], showMainWindow: 0 };
  globalThis.__dh = {
    windows: () => windows,
    open: async (...args) => {
      calls.open.push(args);
      return { canceled: false, filePaths: ['C:\\picked'] };
    },
    save: async (...args) => {
      calls.save.push(args);
      return { canceled: false, filePath: 'C:\\out' };
    },
    message: async (...args) => {
      calls.message.push(args);
      return { response: 1 };
    },
    showMainWindow: async () => {
      calls.showMainWindow++;
      onShowMainWindow(windows);
    },
  };
  return { windows, calls };
};

test('文件对话框永远不挂父窗口——跨线程模态框会不可见并卡死应用', async () => {
  const h = harness();
  await showOpenDialogSafely({ properties: ['openDirectory'] });

  assert.equal(h.calls.open.length, 1);
  assert.equal(h.calls.open[0].length, 1, '只能传 options，不能传父窗口');
  assert.deepEqual(h.calls.open[0][0], { properties: ['openDirectory'] });
});

test('保存对话框与消息框同样不挂父窗口', async () => {
  const h = harness();
  await showSaveDialogSafely({ title: '导出设置备份' });
  await showMessageBoxSafely({ message: '确认导入？' });

  assert.equal(h.calls.save[0].length, 1);
  assert.equal(h.calls.message[0].length, 1);
});

test('已有可见窗口时不惊动窗口状态机', async () => {
  const h = harness();
  await showOpenDialogSafely({ properties: ['openFile'] });

  assert.equal(h.calls.showMainWindow, 0);
});

test('全部窗口隐藏时先带一个到前台', async () => {
  const win = makeWindow({ visible: false });
  const h = harness([win], (list) => {
    list[0].visible = true;
  });
  await showOpenDialogSafely({ properties: ['openFile'] });

  assert.equal(h.calls.showMainWindow, 1);
  assert.equal(h.calls.open[0].length, 1, '置前后仍不挂父窗口');
});

test('窗口处于最小化时同样先恢复', async () => {
  const win = makeWindow({ minimized: true });
  const h = harness([win], (list) => {
    list[0].minimized = false;
  });
  await showOpenDialogSafely({ properties: ['openFile'] });

  assert.equal(h.calls.showMainWindow, 1);
});

test('销毁的窗口不算可见', async () => {
  const h = harness([makeWindow({ destroyed: true }), makeWindow({ visible: false })], (list) => {
    list[1].visible = true;
  });
  await showOpenDialogSafely({ properties: ['openFile'] });

  assert.equal(h.calls.showMainWindow, 1);
});

test('标题统一带上应用名：独立窗口没有模态归属，用户才知道是谁在问', async () => {
  const h = harness();
  await showOpenDialogSafely({ title: '选择要上传的音乐文件' });
  await showMessageBoxSafely({ title: '是否覆盖现有备份？' });

  assert.equal(h.calls.open[0][0].title, 'EchoMusic · 选择要上传的音乐文件');
  assert.equal(h.calls.message[0][0].title, 'EchoMusic · 是否覆盖现有备份？');
});

test('标题里已有应用名不重复添加；无标题时保持原样', async () => {
  const h = harness();
  await showSaveDialogSafely({ title: '创建 EchoMusic 备份' });
  await showSaveDialogSafely({ properties: ['openFile'] });

  assert.equal(h.calls.save[0][0].title, '创建 EchoMusic 备份');
  assert.equal(h.calls.save[1][0].title, undefined);
});

test('置前失败也必须照常弹框，不能把调用方挂住', async () => {
  const h = harness([makeWindow({ visible: false })]);
  const result = await showOpenDialogSafely({ properties: ['openFile'] });

  assert.equal(h.calls.open.length, 1);
  assert.ok(result.filePaths.length);
});

test('置前永久挂起时超时放行，不把「弹窗卡死」换个形式请回来', async () => {
  const h = harness([makeWindow({ visible: false })]);
  // showMainWindow() 内部会等 mainWindowStartup，渲染进程起不来时永不 resolve。
  globalThis.__dh.showMainWindow = () => new Promise(() => {});
  const started = Date.now();
  const result = await showOpenDialogSafely({ properties: ['openFile'] });
  const elapsed = Date.now() - started;

  assert.equal(h.calls.open.length, 1, '超时后仍要弹框');
  assert.ok(result.filePaths.length);
  assert.ok(elapsed < 5000, `应在超时上限内放行，实际 ${elapsed}ms`);
});

test('返回值原样透传给调用方', async () => {
  const h = harness();
  globalThis.__dh.open = async () => ({ canceled: true, filePaths: [] });
  const result = await showOpenDialogSafely({ properties: ['openFile'] });

  assert.equal(result.canceled, true);
  assert.deepEqual(result.filePaths, []);
});