import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { build, transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const result = await build({
  stdin: {
    contents: `export * from './src/renderer/theme/imageCrop';export * from './src/renderer/theme/imageStyle';export {defaultOverride,normalizeImageCrop} from './src/renderer/theme/model';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
const module = { exports: {} };
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports);
const {
  customBackgroundImageGeometry: geometry,
  backgroundCropLayout: layout,
  backgroundCropStage: fitStage,
  moveBackgroundCrop: move,
  resizeBackgroundCrop: resize,
  normalizeImageCrop,
  defaultOverride,
} = module.exports;
const defaults = defaultOverride().background;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7);

test('cover crops remain covered at all drag endpoints and image/window aspect ratios', () => {
  for (const viewport of [
    { width: 1000, height: 750 },
    { width: 610.5, height: 1200.25 },
  ]) {
    for (const image of [
      { width: 1600, height: 900 },
      { width: 800, height: 1600 },
    ]) {
      for (const zoom of [100, 110, 200]) {
        for (const positionX of [0, 50, 100]) {
          for (const positionY of [0, 50, 100]) {
            const bounds = geometry(viewport, image, { ...defaults, zoom, positionX, positionY });
            assert.ok(bounds.left <= -1 + 1e-7);
            assert.ok(bounds.top <= -1 + 1e-7);
            assert.ok(bounds.left + bounds.width >= viewport.width + 1 - 1e-7);
            assert.ok(bounds.top + bounds.height >= viewport.height + 1 - 1e-7);
          }
        }
      }
    }
  }
});

const stageSize = { width: 718, height: 300 },
  viewport = { width: 1200, height: 800 },
  imageSize = { width: 1600, height: 900 };
const selected = { x: 300, y: 200, width: 800, height: 400, sourceWidth: 1600, sourceHeight: 900 };
const background = { ...defaults, crop: selected };
const cropLayout = layout(stageSize, viewport, imageSize, background);

test('the crop stage hugs wide and tall photographs with only corner-handle padding', () => {
  for (const space of [
    { width: 1000, height: 400 },
    { width: 400, height: 700 },
  ]) {
    for (const image of [
      { width: 1600, height: 1200 },
      { width: 900, height: 1600 },
    ]) {
      const stage = fitStage(space, image);
      const result = layout(stage, viewport, image, defaults);
      assert.ok(stage.width <= space.width && stage.height <= space.height);
      close(result.artwork.left, 16);
      close(result.artwork.top, 16);
      close(stage.width - result.artwork.width, 32);
      close(stage.height - result.artwork.height, 32);
      assert.ok(
        Math.abs(stage.width - space.width) < 1e-7 || Math.abs(stage.height - space.height) < 1e-7,
      );
    }
  }
});

test('moving the selection leaves the whole photograph fixed and clamps all four edges', () => {
  const crop = move(cropLayout, 20, 10);
  close(crop.x - selected.x, 20 / cropLayout.scale);
  close(crop.y - selected.y, 10 / cropLayout.scale);
  const after = layout(stageSize, viewport, imageSize, { ...background, crop });
  assert.deepEqual(after.artwork, cropLayout.artwork);
  close(after.crop.left - cropLayout.crop.left, 20);
  close(after.crop.top - cropLayout.crop.top, 10);
  const min = move(cropLayout, -1e6, -1e6),
    max = move(cropLayout, 1e6, 1e6);
  assert.equal(min.x, 0);
  assert.equal(min.y, 0);
  assert.equal(max.x + max.width, imageSize.width);
  assert.equal(max.y + max.height, imageSize.height);
});

test('free resizing changes width and height independently, retaining each opposite corner', () => {
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    const crop = resize(cropLayout, corner, 20, 0);
    assert.notEqual(crop.width, selected.width);
    assert.equal(crop.height, selected.height);
    assert.equal(crop.y, selected.y);
    close(
      corner.endsWith('e') ? crop.x : crop.x + crop.width,
      corner.endsWith('e') ? selected.x : selected.x + selected.width,
    );
    const vertical = resize(cropLayout, corner, 0, 15);
    assert.equal(vertical.width, selected.width);
    assert.notEqual(vertical.height, selected.height);
    close(
      corner.startsWith('s') ? vertical.y : vertical.y + vertical.height,
      corner.startsWith('s') ? selected.y : selected.y + selected.height,
    );
    assert.deepEqual(
      layout(stageSize, viewport, imageSize, { ...background, crop }).artwork,
      cropLayout.artwork,
    );
  }
});

test('resize endpoints stay inside the image and retain usable handle spacing', () => {
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    for (const delta of [-1e6, 1e6]) {
      const crop = resize(cropLayout, corner, delta, delta);
      assert.ok(crop.x >= 0 && crop.y >= 0);
      assert.ok(crop.x + crop.width <= imageSize.width);
      assert.ok(crop.y + crop.height <= imageSize.height);
      assert.ok(crop.width * cropLayout.scale >= 24 - 1e-7);
      assert.ok(crop.height * cropLayout.scale >= 24 - 1e-7);
    }
  }
});

test('saved free crops retain their source region across stage and window aspect changes', () => {
  const after = layout(
    { width: 400, height: 600 },
    { width: 800, height: 1600 },
    imageSize,
    background,
  );
  assert.deepEqual(after.selection, selected);
  close(after.crop.width / after.crop.height, 2);
});

test('invalid persisted crops are rejected, and valid out-of-bounds crops are normalized', () => {
  assert.equal(normalizeImageCrop(null), null);
  assert.equal(normalizeImageCrop({ ...selected, width: NaN }), null);
  assert.equal(normalizeImageCrop({ ...selected, sourceWidth: 0 }), null);
  assert.equal(normalizeImageCrop({ ...selected, height: -1 }), null);
  const crop = normalizeImageCrop({ ...selected, x: -5, y: 890, width: 1700, height: 100 });
  assert.deepEqual(crop, { ...selected, x: 0, y: 890, width: 1600, height: 10 });
});

const { descriptor } = parse(readFileSync('src/renderer/theme/ThemeImageCropper.vue', 'utf8'));
const script = compileScript(descriptor, { id: 'theme-crop-interaction' });
const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });

async function fixture(t) {
  const hooks = {};
  const width = vue.shallowRef(718),
    height = vue.shallowRef(300);
  const captures = new Set(),
    changes = [];
  const target = {
    focus() {},
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture: (id) => captures.delete(id),
  };
  const props = vue.shallowReactive({
    image: 'test-image',
    background: { ...defaults, zoom: 140 },
    viewport: { width: 1200, height: 800 },
    maxHeight: 300,
    shell: '#202020',
    disabled: false,
  });
  const component = { exports: {} };
  new Function('require', 'module', 'exports', 'Image', code)(
    (id) => {
      if (id === 'vue')
        return {
          ...vue,
          useId: () => 'crop-help',
          onDeactivated: (fn) => {
            hooks.deactivate = fn;
          },
          onBeforeUnmount: (fn) => {
            hooks.unmount = fn;
          },
        };
      if (id === '@vueuse/core') return { useElementSize: () => ({ width, height }) };
      if (id === '@/components/ui/Button.vue') return { default: {} };
      if (id === './imageCrop') return module.exports;
      throw Error(`Unexpected dependency ${id}`);
    },
    component,
    component.exports,
    class {
      naturalWidth = 1600;
      naturalHeight = 900;
      set src(_) {
        this.onload();
      }
    },
  );
  const scope = vue.effectScope();
  const api = scope.run(() =>
    component.exports.default.setup(props, {
      expose() {},
      emit(type, position) {
        if (type !== 'change') return;
        changes.push(position);
        props.background = { ...props.background, ...position };
      },
    }),
  );
  t.after(() => {
    hooks.unmount();
    scope.stop();
  });
  const pointer = (x, y, type = 'pointermove') => ({
    type,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y,
    currentTarget: target,
    preventDefault() {},
  });
  await vue.nextTick();
  return { api, props, width, captures, changes, hooks, pointer };
}

test('continuous pointer capture survives parent updates and releases after an outside pointerup', async (t) => {
  const f = await fixture(t);
  f.api.startDrag(f.pointer(100, 100, 'pointerdown'));
  f.api.moveDrag(f.pointer(110, 110));
  await vue.nextTick();
  assert.equal(f.captures.has(1), true);
  const first = f.props.background.crop.x;
  f.api.moveDrag(f.pointer(120, 120));
  await vue.nextTick();
  assert.ok(f.props.background.crop.x > first);
  assert.equal(f.api.dragging.value, true);
  f.api.endDrag(f.pointer(2000, 2000, 'pointerup'));
  const crop = f.props.background.crop;
  close(crop.x + crop.width, crop.sourceWidth);
  close(crop.y + crop.height, crop.sourceHeight);
  assert.equal(f.captures.size, 0);
  assert.equal(f.api.dragging.value, false);
  const count = f.changes.length;
  f.api.moveDrag(f.pointer(0, 0));
  assert.equal(f.changes.length, count);
});

test('resize, cancellation and page deactivation terminate a drag without stale pointer updates', async (t) => {
  const f = await fixture(t);
  f.api.startDrag(f.pointer(100, 100, 'pointerdown'));
  f.width.value = 640;
  await vue.nextTick();
  assert.equal(f.captures.size, 0);
  f.api.moveDrag(f.pointer(120, 120));
  assert.equal(f.changes.length, 0);
  f.api.startDrag(f.pointer(100, 100, 'pointerdown'));
  f.api.endDrag(f.pointer(300, 300, 'pointercancel'));
  assert.equal(f.changes.length, 0);
  assert.equal(f.captures.size, 0);
  f.api.startDrag(f.pointer(100, 100, 'pointerdown'));
  f.hooks.deactivate();
  assert.equal(f.captures.size, 0);
  assert.equal(f.api.dragging.value, false);
});

test('corner resizing remains captured through parent updates and can change aspect freely', async (t) => {
  const f = await fixture(t);
  const before = f.api.geometry.value;
  f.api.startDrag(f.pointer(100, 100, 'pointerdown'), 'se');
  f.api.moveDrag(f.pointer(80, 100));
  await vue.nextTick();
  assert.equal(f.captures.has(1), true);
  assert.deepEqual(f.api.geometry.value.artwork, before.artwork);
  assert.ok(f.props.background.crop.width < before.selection.width);
  close(f.props.background.crop.height, before.selection.height);
  const first = f.props.background.crop.width;
  f.api.moveDrag(f.pointer(70, 100));
  await vue.nextTick();
  assert.ok(f.props.background.crop.width < first);
  f.api.endDrag(f.pointer(70, 100, 'pointerup'));
  assert.equal(f.captures.size, 0);
});

test('selecting the full original image keeps other background settings', async (t) => {
  const f = await fixture(t);
  f.props.background = { ...f.props.background, shade: 25, panelOpacity: 40, textColor: '#6633ff' };
  f.api.selectWholeImage();
  assert.deepEqual(f.props.background.crop, {
    x: 0,
    y: 0,
    width: 1600,
    height: 900,
    sourceWidth: 1600,
    sourceHeight: 900,
  });
  assert.equal(f.props.background.shade, 25);
  assert.equal(f.props.background.panelOpacity, 40);
  assert.equal(f.props.background.textColor, '#6633ff');
});

test('applying without dragging saves the visible crop, while a disabled editor cannot commit', async (t) => {
  const f = await fixture(t);
  const visible = { ...f.api.geometry.value.selection };
  assert.equal(f.props.background.crop, null);
  assert.equal(f.api.commitSelection(), true);
  assert.deepEqual(f.props.background.crop, visible);
  f.props.background = { ...f.props.background, crop: null };
  f.props.disabled = true;
  assert.equal(f.api.commitSelection(), false);
  assert.equal(f.props.background.crop, null);
});
