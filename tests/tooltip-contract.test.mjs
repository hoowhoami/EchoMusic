import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { parse, compileScript, registerTS } from '@vue/compiler-sfc';

registerTS(() => createRequire(import.meta.url)('typescript'));

function vueFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? vueFiles(path) : path.endsWith('.vue') ? [path] : [];
  });
}

test('tooltips preserve the rendered control, accessible label and disabled semantics', async () => {
  const { build } = await import('esbuild');
  const { createSSRApp, defineComponent, h } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const result = await build({
    stdin: {
      contents: `export { default as Button } from './src/renderer/components/ui/Button.vue';
        export { default as Tooltip } from './src/renderer/components/ui/Tooltip.vue';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'vue-test-components',
        setup(build) {
          build.onResolve({ filter: /^(vue|reka-ui)$/ }, ({ path }) => ({
            path: import.meta.resolve(path),
            external: true,
          }));
          build.onLoad({ filter: /\.vue$/ }, ({ path }) => {
            const { descriptor, errors } = parse(readFileSync(path, 'utf8'), { filename: path });
            assert.deepEqual(errors, [], `invalid Vue component: ${path}`);
            const script = compileScript(descriptor, { id: path, inlineTemplate: true });
            return { contents: script.content, loader: 'ts', resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const { Button, Tooltip } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
  const render = (component) => renderToString(createSSRApp({ render: () => component }));
  const overflowButton = await render(
    h(Tooltip, { content: '音效名称' }, () =>
      h(Button, { disabled: true, 'aria-label': '音效名称' }, () => '音效名称'),
    ),
  );
  assert.equal((overflowButton.match(/<button\b/g) || []).length, 1);
  assert.match(overflowButton, /aria-label="音效名称"/);
  assert.match(overflowButton, /\bdisabled/);
  assert.doesNotMatch(overflowButton, /<span|<div/);
  for (const tooltip of [undefined, '', '保存']) {
    const html = await render(
      h(Button, { tooltip, disabled: true, id: 'save', 'aria-label': '保存设置' }, () => '保存'),
    );
    assert.match(html, /<button\b[^>]*disabled/);
    assert.match(html, /aria-label="保存设置"/);
    assert.match(html, /id="save"/);
    assert.equal((html.match(/<button\b/g) || []).length, 1);
    assert.doesNotMatch(html, /\btitle=|<span|<div/);
  }
  const nativeTitle = await render(
    h(Button, { title: '音量 · 50%', 'aria-label': '音量', disabled: true }),
  );
  assert.match(nativeTitle, /<button\b[^>]*title="音量 · 50%"/);
  assert.match(nativeTitle, /aria-label="音量"/);
  assert.match(nativeTitle, /<button\b[^>]*disabled/);
  assert.doesNotMatch(nativeTitle, /role="tooltip"|data-state=/);
  for (const tooltip of [undefined, '后退']) {
    const toolbar = {
      __scopeId: 'data-v-toolbar-regression',
      render: () => h('header', null, [h(Button, { tooltip, class: 'nav-btn' }, () => '后退')]),
    };
    const html = await render(h(toolbar));
    assert.match(
      html,
      /<button\b[^>]*data-v-toolbar-regression/,
      'button must retain caller scoped styles with or without tooltip',
    );
  }
  const fallback = await render(
    h(Tooltip, { disabled: true }, { default: () => h('a', { href: '#test' }, '仍可操作') }),
  );
  assert.match(fallback, /<a href="#test">仍可操作<\/a>/);
  const explicitFallback = await render(
    h(
      Tooltip,
      { disabled: true },
      { default: () => h('b', 'trigger'), fallback: () => h('span', 'fallback') },
    ),
  );
  assert.match(explicitFallback, /<span>fallback<\/span>/);
  assert.doesNotMatch(explicitFallback, /<b>/);
  // A plugin can mount a tooltip without inheriting the application provider.
  const standalone = await render(
    h(Tooltip, { content: '插件提示' }, { default: () => h('button', '插件') }),
  );
  assert.match(standalone, /<button\b/);
  const rich = await render(
    h(
      Tooltip,
      {},
      {
        default: () => h('button', '设置'),
        content: () => h('strong', '额外说明'),
      },
    ),
  );
  assert.match(rich, /<button\b[^>]*>设置<\/button>/);
  assert.doesNotMatch(rich, /<strong|额外说明/);
});

test('hover panels and the mini volume slider do not have redundant trigger tooltips', () => {
  const offenders = [];
  let checked = 0;
  for (const file of vueFiles('src')) {
    const ast = parse(readFileSync(file, 'utf8')).descriptor.template?.ast;
    function checkTrigger(node) {
      if (
        node.type === 1 &&
        (node.tag === 'Tooltip' ||
          node.props.some((prop) => prop.type === 7 && prop.name === 'tooltip') ||
          node.props.some(
            (prop) =>
              (prop.type === 6 && ['tooltip', 'title'].includes(prop.name)) ||
              (prop.type === 7 &&
                prop.name === 'bind' &&
                ['tooltip', 'title'].includes(prop.arg?.content)),
          ))
      )
        offenders.push(`${file}:${node.loc.start.line}`);
      node.children?.forEach(checkTrigger);
    }
    function visit(node) {
      if (node.type === 1) {
        if (node.tag === 'Popover') {
          const trigger = node.props.find(
            (prop) =>
              (prop.type === 6 && prop.name === 'trigger') ||
              (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'trigger'),
          );
          if (
            !trigger ||
            trigger.value?.content === 'hover' ||
            trigger.exp?.content.includes("'hover'")
          ) {
            const slot = node.children.find(
              (child) =>
                child.type === 1 &&
                child.props.some(
                  (prop) =>
                    prop.type === 7 && prop.name === 'slot' && prop.arg?.content === 'trigger',
                ),
            );
            if (slot) {
              checked++;
              checkTrigger(slot);
            }
          }
        }
        if (
          node.props.some(
            (prop) =>
              prop.type === 6 &&
              prop.name === 'class' &&
              prop.value?.content.split(/\s+/).includes('mini-volume'),
          )
        ) {
          checked++;
          checkTrigger(node);
        }
      }
      node.children?.forEach(visit);
    }
    if (ast) visit(ast);
  }
  assert.ok(checked >= 2, 'must cover hover panels and the custom mini volume slider');
  assert.deepEqual(offenders, []);
});

test('direct hints bind to native elements; reusable tooltip wrappers delegate their trigger slot', () => {
  const offenders = [];
  for (const file of vueFiles('src/renderer')) {
    const ast = parse(readFileSync(file, 'utf8')).descriptor.template?.ast;
    function visit(node) {
      if (
        node.type === 1 &&
        node.props.some((prop) => prop.type === 7 && prop.name === 'tooltip') &&
        (!/^[a-z]/.test(node.tag) || node.tag === 'component')
      )
        offenders.push(`${file}:${node.loc.start.line}: directive on component`);
      if (node.type === 1 && node.tag === 'Tooltip') {
        const trigger = node.children.find(
          (child) =>
            child.type === 1 &&
            child.tag === 'template' &&
            child.props.some(
              (p) => p.type === 7 && p.name === 'slot' && p.arg?.content === 'trigger',
            ),
        );
        const child = trigger?.children.find((node) => node.type === 1);
        if (child && /^[a-z]/.test(child.tag) && !['component', 'slot'].includes(child.tag))
          offenders.push(`${file}:${node.loc.start.line}: unnecessary wrapper`);
      }
      node.children?.forEach(visit);
    }
    if (ast) visit(ast);
  }
  assert.deepEqual(offenders, []);
});
