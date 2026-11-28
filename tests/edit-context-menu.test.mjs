import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const code = transformSync(
  readFileSync(new URL('../src/main/editContextMenu.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

const load = (clipboardText, ownerWindow = null) => {
  const popped = [];
  const electron = {
    BrowserWindow: { fromWebContents: () => ownerWindow },
    Menu: {
      buildFromTemplate: (template) => ({
        popup: (options) => popped.push({ template, options }),
      }),
    },
    clipboard: { readText: () => clipboardText },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    require(name) {
      if (name === 'electron') return electron;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { api: module.exports, popped };
};

const createContents = (url = 'https://echo.music') => {
  const contents = new EventEmitter();
  const commands = [];
  contents.getURL = () => url;
  for (const command of ['cut', 'copy', 'paste', 'selectAll']) {
    contents[command] = () => commands.push(command);
  }
  return { contents, commands };
};

const fireContextMenu = (contents, params) => {
  contents.emit('context-menu', {}, params);
};

const findItem = (template, label) => template.find((item) => item.label === label);

const EDIT_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

test('非输入框目标不弹菜单', () => {
  const { api, popped } = load('剪贴板文本');
  const { contents } = createContents();
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, { isEditable: false, editFlags: EDIT_FLAGS });
  assert.equal(popped.length, 0);
});

test('devtools 页面不接管菜单', () => {
  const { api, popped } = load('剪贴板文本');
  const { contents } = createContents('devtools://devtools/bundled/inspector.html');
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, { isEditable: true, editFlags: EDIT_FLAGS });
  assert.equal(popped.length, 0);
});

test('可编辑目标弹出菜单且窗口选项来自承载窗口', () => {
  const ownerWindow = { id: 1 };
  const { api, popped } = load('剪贴板文本', ownerWindow);
  const { contents } = createContents();
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, { isEditable: true, editFlags: EDIT_FLAGS });
  assert.equal(popped.length, 1);
  assert.equal(popped[0].options.window, ownerWindow);
  // 模板数组产自 vm realm，用 join 比较避免跨 realm 原型差异
  assert.equal(
    popped[0].template
      .filter((item) => item.type !== 'separator')
      .map((item) => item.label)
      .join(','),
    '剪切,复制,粘贴,全选',
  );
});

test('承载窗口为 null 时 popup 省略 window 选项', () => {
  const { api, popped } = load('剪贴板文本');
  const { contents } = createContents();
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, { isEditable: true, editFlags: EDIT_FLAGS });
  assert.equal(popped.length, 1);
  assert.equal(popped[0].options.window, undefined);
});

test('菜单项可用状态跟随 editFlags', () => {
  const { api, popped } = load('剪贴板文本');
  const { contents } = createContents();
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, {
    isEditable: true,
    editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: false },
  });
  assert.equal(popped.length, 1);
  const { template } = popped[0];
  assert.equal(findItem(template, '剪切').enabled, false);
  assert.equal(findItem(template, '复制').enabled, true);
  assert.equal(findItem(template, '粘贴').enabled, true);
  assert.equal(findItem(template, '全选').enabled, false);
});

test('剪贴板为空时粘贴置灰', () => {
  const { api, popped } = load('');
  const { contents } = createContents();
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, { isEditable: true, editFlags: EDIT_FLAGS });
  assert.equal(popped.length, 1);
  assert.equal(findItem(popped[0].template, '粘贴').enabled, false);
});

test('点击菜单项触发对应编辑命令', () => {
  const { api, popped } = load('剪贴板文本');
  const { contents, commands } = createContents();
  api.configureEditContextMenu(contents);
  fireContextMenu(contents, { isEditable: true, editFlags: EDIT_FLAGS });
  assert.equal(popped.length, 1);
  const { template } = popped[0];
  for (const label of ['剪切', '复制', '粘贴', '全选']) findItem(template, label).click();
  assert.deepEqual(commands, ['cut', 'copy', 'paste', 'selectAll']);
});
