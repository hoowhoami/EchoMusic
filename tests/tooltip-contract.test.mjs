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

test('native controls cannot reintroduce browser title tooltips; business title props are allowed', () => {
  const offenders = [];
  for (const file of vueFiles('src')) {
    const ast = parse(readFileSync(file, 'utf8')).descriptor.template?.ast;
    function visit(node) {
      if (
        node.type === 1 &&
        (/^[a-z]/.test(node.tag) ||
          ['Button', 'DatePickerPrev', 'DatePickerNext', 'TabsTrigger'].includes(node.tag))
      ) {
        for (const prop of node.props) {
          if (
            (prop.type === 6 && prop.name === 'title') ||
            (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'title')
          ) {
            offenders.push(`${file}:${prop.loc.start.line} ${node.tag}`);
          }
        }
      }
      node.children?.forEach(visit);
    }
    if (ast) visit(ast);
  }
  assert.deepEqual(offenders, []);
});

test('tooltips preserve the rendered control, accessible label and disabled semantics', async () => {
  const { build } = await import('esbuild');
  const { createSSRApp, h } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const result = await build({
    stdin: {
      contents: `export { default as Button } from './src/renderer/components/ui/Button.vue';
        export { default as Tooltip } from './src/renderer/components/ui/Tooltip.vue';
        export { default as Scope } from './src/renderer/components/ui/TooltipScope.vue';`,
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
  const { Button, Tooltip, Scope } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
  const render = (component) => renderToString(createSSRApp({ render: () => component }));
  for (const tooltip of [undefined, '', '保存']) {
    const html = await render(
      h(Scope, null, {
        default: () =>
          h(
            Button,
            { tooltip, disabled: true, id: 'save', 'aria-label': '保存设置' },
            () => '保存',
          ),
      }),
    );
    assert.match(html, /<button\b[^>]*disabled/);
    assert.match(html, /aria-label="保存设置"/);
    assert.match(html, /id="save"/);
    assert.equal((html.match(/<button\b/g) || []).length, 1);
    assert.doesNotMatch(html, /\btitle=|<span|<div/);
  }
  for (const tooltip of [undefined, '后退']) {
    const toolbar = {
      __scopeId: 'data-v-toolbar-regression',
      render: () => h('header', null, [h(Button, { tooltip, class: 'nav-btn' }, () => '后退')]),
    };
    const html = await render(h(Scope, null, { default: () => h(toolbar) }));
    assert.match(
      html,
      /<button\b[^>]*data-v-toolbar-regression/,
      'button must retain caller scoped styles with or without tooltip',
    );
  }
  const fallback = await render(
    h(Tooltip, { disabled: true }, { trigger: () => h('a', { href: '#test' }, '仍可操作') }),
  );
  assert.match(fallback, /<a href="#test">仍可操作<\/a>/);
  const explicitFallback = await render(
    h(
      Tooltip,
      { disabled: true },
      { trigger: () => h('b', 'trigger'), fallback: () => h('span', 'fallback') },
    ),
  );
  assert.match(explicitFallback, /<span>fallback<\/span>/);
  assert.doesNotMatch(explicitFallback, /<b>/);
  // A plugin can mount a tooltip without inheriting the application provider.
  const standalone = await render(
    h(Tooltip, { content: '插件提示' }, { trigger: () => h('button', '插件') }),
  );
  assert.match(standalone, /<button\b/);
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
  assert.ok(checked >= 9, 'must cover shared hover panels and the custom mini volume slider');
  assert.deepEqual(offenders, []);
});
