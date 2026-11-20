import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import {
  getManifestPluginPlatforms,
  getPluginPlatformLabel,
  normalizePluginPlatform,
  validatePluginPlatformsRequirement,
} from '../src/shared/plugins.ts';

// descriptor.ts 依赖 electron（app.getVersion），按 installer-stream 测试同款方式打包并 mock
const require = createRequire(import.meta.url);

const COMMON_MOCK = `
export const PLUGIN_IMAGE_EXTENSIONS = new Set(['.png', '.svg'])
export const PLUGIN_MANIFEST_FILE = 'manifest.json'
export const PLUGIN_WINDOW_MIN_WIDTH = 1
export const PLUGIN_WINDOW_MIN_HEIGHT = 1
export const PLUGIN_WINDOW_MAX_WIDTH = 100000
export const PLUGIN_WINDOW_MAX_HEIGHT = 100000
export const BARE_SEMVER_PATTERN = /^v?\\d+(?:\\.\\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
export const normalizePluginId = (value) => String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '')
`;

const bundle = await build({
  stdin: {
    contents:
      "export { getEchoMusicCompatibility, validateManifest, isMarketplaceUpdateAvailable } from './src/main/plugins/descriptor';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: [
    {
      name: 'descriptor-fixture',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
        b.onResolve({ filter: /^\.\/(common|path)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
          if (args.path === 'electron') {
            return {
              // 版本可按用例调整，供主程序版本要求相关断言使用
              contents:
                "globalThis.__pluginDescriptorFixture = { version: '2.3.3' }\nexport const app = { getVersion: () => globalThis.__pluginDescriptorFixture.version }",
              loader: 'js',
            };
          }
          if (args.path === './path') {
            return { contents: 'export const resolvePluginFile = () => ""', loader: 'js' };
          }
          return { contents: COMMON_MOCK, loader: 'js' };
        });
      },
    },
  ],
});

const descriptorModule = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  require,
  descriptorModule,
  descriptorModule.exports,
);
const { getEchoMusicCompatibility, validateManifest, isMarketplaceUpdateAvailable } =
  descriptorModule.exports;

// process.platform 在用例间切换，结束后恢复真实值
const withPlatform = (platform: string, run: () => void) => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
};

test('平台归一化只接受规范名，不解析别名', () => {
  assert.equal(normalizePluginPlatform('windows'), 'windows');
  assert.equal(normalizePluginPlatform('macos'), 'macos');
  assert.equal(normalizePluginPlatform('linux'), 'linux');
  assert.equal(normalizePluginPlatform('  linux  '), 'linux');
  assert.equal(normalizePluginPlatform('win32'), '');
  assert.equal(normalizePluginPlatform('darwin'), '');
  assert.equal(normalizePluginPlatform('android'), '');
  assert.equal(normalizePluginPlatform(''), '');
  assert.equal(normalizePluginPlatform(undefined), '');
});

test('平台标签用顿号拼接展示名', () => {
  assert.equal(getPluginPlatformLabel(['windows', 'macos']), 'Windows、macOS');
  assert.equal(getPluginPlatformLabel(['linux']), 'Linux');
  assert.equal(getPluginPlatformLabel([]), '');
  assert.equal(getPluginPlatformLabel(['nope']), '');
});

test('requires.platforms 声明格式校验', () => {
  assert.equal(validatePluginPlatformsRequirement(undefined), '');
  assert.equal(validatePluginPlatformsRequirement(['windows']), '');
  assert.equal(validatePluginPlatformsRequirement(['windows', 'macos', 'linux']), '');
  assert.notEqual(validatePluginPlatformsRequirement([]), '');
  assert.notEqual(validatePluginPlatformsRequirement('windows'), '');
  assert.notEqual(validatePluginPlatformsRequirement(['win32']), '');
  assert.notEqual(validatePluginPlatformsRequirement(['windows', 'windows']), '');
  assert.notEqual(validatePluginPlatformsRequirement(['windows', 'macos', 'linux', 'windows']), '');
});

test('声明平台读取保持顺序并去重', () => {
  assert.deepEqual(getManifestPluginPlatforms(['macos', 'windows', 'macos']), ['macos', 'windows']);
  assert.deepEqual(getManifestPluginPlatforms(undefined), []);
  assert.deepEqual(getManifestPluginPlatforms(['android']), []);
});

test('未声明平台时全平台可用，兼容性字段完整', () => {
  withPlatform('win32', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
    });
    assert.equal(compatibility.compatible, true);
    assert.equal(compatibility.platformIncompatible, false);
    assert.equal(compatibility.currentPlatform, 'windows');
    assert.deepEqual(compatibility.platforms, []);
    assert.equal(compatibility.platformLabel, '');
    assert.equal(compatibility.message, '');
  });
});

test('声明平台包含当前平台时兼容', () => {
  withPlatform('win32', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      requires: { platforms: ['windows', 'linux'] },
    });
    assert.equal(compatibility.compatible, true);
    assert.equal(compatibility.platformIncompatible, false);
    assert.deepEqual(compatibility.platforms, ['windows', 'linux']);
    assert.equal(compatibility.platformLabel, 'Windows、Linux');
  });
});

test('声明平台不含当前平台时不兼容并给出提示', () => {
  withPlatform('win32', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      requires: { platforms: ['macos'] },
    });
    assert.equal(compatibility.compatible, false);
    assert.equal(compatibility.platformIncompatible, true);
    assert.equal(compatibility.message, '此插件仅支持 macOS，当前平台为 Windows');
  });
});

test('未知平台视为不被任何声明支持', () => {
  withPlatform('freebsd', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      requires: { platforms: ['linux'] },
    });
    assert.equal(compatibility.compatible, false);
    assert.equal(compatibility.platformIncompatible, true);
    assert.equal(compatibility.currentPlatform, '');
    assert.equal(compatibility.message, '此插件仅支持 Linux，当前平台为 freebsd');
  });
});

test('平台原因优先于版本原因展示', () => {
  withPlatform('win32', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      requires: { echoMusicVersion: '>=99', platforms: ['macos'] },
    });
    assert.equal(compatibility.compatible, false);
    assert.equal(compatibility.message, '此插件仅支持 macOS，当前平台为 Windows');
  });
});

test('仅版本不满足时保持版本提示', () => {
  withPlatform('win32', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      requires: { echoMusicVersion: '>=99' },
    });
    assert.equal(compatibility.compatible, false);
    assert.equal(compatibility.platformIncompatible, false);
    assert.match(compatibility.message, /版本不兼容/);
    // semver 会把裸版本范围归一化为完整三段式
    assert.equal(compatibility.requiredEchoMusicVersion, '>=99.0.0');
  });
});

test('目录版本可更新判定叠加兼容门', () => {
  // 兼容 + 更高版本 → 可更新
  withPlatform('win32', () => {
    const compatibility = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '2.0.0',
    });
    assert.equal(isMarketplaceUpdateAvailable(compatibility, '2.0.0', '1.0.0'), true);
    assert.equal(isMarketplaceUpdateAvailable(compatibility, '1.0.0', '1.0.0'), false);
    assert.equal(isMarketplaceUpdateAvailable(compatibility, '0.9.0', '1.0.0'), false);

    // 平台不兼容 + 更高版本 → 不可更新
    const platformIncompatible = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '2.0.0',
      requires: { platforms: ['macos'] },
    });
    assert.equal(isMarketplaceUpdateAvailable(platformIncompatible, '2.0.0', '1.0.0'), false);

    // 主程序版本不兼容 + 更高版本 → 不可更新
    const versionIncompatible = getEchoMusicCompatibility({
      id: 'demo',
      name: 'demo',
      version: '2.0.0',
      requires: { echoMusicVersion: '>=99' },
    });
    assert.equal(isMarketplaceUpdateAvailable(versionIncompatible, '2.0.0', '1.0.0'), false);
  });
});

test('manifest 平台声明格式错误按无效清单拒绝', () => {
  assert.equal(
    validateManifest(
      { id: 'demo', name: 'demo', version: '1.0.0', requires: { platforms: ['windows'] } },
      '',
    ),
    '',
  );
  assert.notEqual(
    validateManifest(
      { id: 'demo', name: 'demo', version: '1.0.0', requires: { platforms: [] } },
      '',
    ),
    '',
  );
  assert.notEqual(
    validateManifest(
      { id: 'demo', name: 'demo', version: '1.0.0', requires: { platforms: ['win32'] } },
      '',
    ),
    '',
  );
  assert.notEqual(
    validateManifest(
      { id: 'demo', name: 'demo', version: '1.0.0', requires: { platforms: ['linux', 'linux'] } },
      '',
    ),
    '',
  );
});
