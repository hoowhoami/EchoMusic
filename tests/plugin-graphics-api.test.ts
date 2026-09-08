import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createPluginGraphicsApi,
  configurePluginHdrCanvas,
  mapPluginSdrPeak,
} from '../src/renderer/plugins/runtime/graphics.ts';

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
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup({
  gpu = true,
  hdr = true,
  accepted = true,
  validationError = false,
  failDevice = false,
} = {}) {
  const media = new Map<string, EventTarget & { matches: boolean }>();
  const devices: any[] = [];
  const canvases: any[] = [];
  const animation = new Map<number, () => void>();
  let nextAnimation = 0;
  const win = Object.assign(new EventTarget(), {
    devicePixelRatio: 2,
    matchMedia(query: string) {
      if (!media.has(query))
        media.set(
          query,
          Object.assign(new EventTarget(), { matches: query === '(dynamic-range: high)' && hdr }),
        );
      return media.get(query)!;
    },
    requestAnimationFrame(callback: () => void) {
      animation.set(++nextAnimation, callback);
      return nextAnimation;
    },
    cancelAnimationFrame(id: number) {
      animation.delete(id);
    },
  });
  const observers: any[] = [];
  globalValue(
    'ResizeObserver',
    class {
      disconnected = false;
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        observers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    createElement() {
      const ctx: any = {
        config: null,
        unconfigured: false,
        configure(config: any) {
          ctx.config = {
            ...config,
            toneMapping: { mode: accepted ? config.toneMapping.mode : 'standard' },
          };
        },
        getConfiguration() {
          return ctx.config;
        },
        unconfigure() {
          ctx.unconfigured = true;
        },
        getCurrentTexture() {
          return { createView: () => ({ output: true }) };
        },
      };
      const canvas: any = {
        style: {},
        width: 300,
        height: 150,
        clientWidth: 200,
        clientHeight: 100,
        isConnected: true,
        getContext(type: string) {
          return type === 'webgpu' ? ctx : { canvas, kind: '2d' };
        },
        remove() {
          canvas.isConnected = false;
        },
        ctx,
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  function makeDevice() {
    const lost = deferred<{ reason: string }>();
    const device: any = {
      destroyed: false,
      lost: lost.promise,
      lose: () => lost.resolve({ reason: 'unknown' }),
      limits: { maxTextureDimension2D: 8192 },
      submissions: 0,
      uniforms: [] as number[][],
      textures: [] as any[],
      scopes: 0,
      pushErrorScope() {
        device.scopes++;
      },
      async popErrorScope() {
        device.scopes--;
        return validationError ? { message: 'invalid' } : null;
      },
      destroy() {
        device.destroyed = true;
        lost.resolve({ reason: 'destroyed' });
      },
      createShaderModule() {
        return {};
      },
      async createRenderPipelineAsync() {
        return { getBindGroupLayout: () => ({}) };
      },
      createBuffer() {
        return { destroy() {} };
      },
      createTexture(desc: any) {
        const texture = {
          desc,
          destroyed: false,
          createView: () => ({ input: true }),
          destroy() {
            texture.destroyed = true;
          },
        };
        device.textures.push(texture);
        return texture;
      },
      createBindGroup() {
        return {};
      },
      createCommandEncoder() {
        return {
          beginRenderPass: () => ({ end() {}, setPipeline() {}, setBindGroup() {}, draw() {} }),
          finish: () => ({}),
        };
      },
      queue: {
        writeBuffer(_b: unknown, _o: unknown, values: Float32Array) {
          device.uniforms.push([...values]);
        },
        submit() {
          device.submissions++;
        },
      },
    };
    devices.push(device);
    return device;
  }
  const adapter = {
    async requestDevice() {
      if (failDevice) throw new Error('gpu unavailable');
      return makeDevice();
    },
  };
  globalValue('window', win);
  globalValue('document', doc);
  globalValue('navigator', {
    gpu: gpu
      ? { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }
      : undefined,
  });
  globalValue('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8 });
  globalValue('GPUTextureUsage', { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 });
  const disposables: (() => void)[] = [];
  const errors: unknown[] = [];
  const api = createPluginGraphicsApi({
    addDisposable: (d) => disposables.push(d),
    runCallback: (_source, fn) => {
      try {
        fn();
      } catch (e) {
        errors.push(e);
      }
    },
  });
  const setHdr = (value: boolean) => {
    const query = win.matchMedia('(dynamic-range: high)');
    query.matches = value;
    query.dispatchEvent(new Event('change'));
  };
  return {
    api,
    devices,
    canvases,
    win,
    doc,
    observers,
    disposables,
    errors,
    setHdr,
    animation,
    adapter,
  };
}

test('capabilities probe is cached, releases GPU resources, and never claims measured HDR', async () => {
  const env = setup();
  const [a, b] = await Promise.all([env.api.getCapabilities(), env.api.getCapabilities()]);
  assert.deepEqual(a, b);
  assert.equal(a.hdrEligible, true);
  assert.equal(a.outputVerification, 'unverified');
  assert.equal(env.devices.length, 1);
  assert.equal(env.devices[0].destroyed, true);
  assert.equal(env.devices[0].scopes, 0);
});

test('ignored extended configuration and GPU validation errors cannot report HDR support', async () => {
  for (const options of [{ accepted: false }, { validationError: true }]) {
    const env = setup(options);
    const caps = await env.api.getCapabilities();
    assert.equal(caps.hdrCanvas, false);
    assert.equal(caps.hdrEligible, false);
    env.disposables[0]();
  }
});

test('display changes update canvas tone mapping without replacing its GPU device or format', async () => {
  const env = setup();
  const surface = await env.api.createCanvas();
  const states: string[] = [];
  surface.onStateChanged((state) => states.push(state.dynamicRange));
  const device = env.devices[0];
  surface.render((frame) => {
    assert.equal(frame.format, 'rgba16float');
    assert.equal(frame.width, 400);
  });
  assert.equal(device.uniforms.at(-1)[0], 1);
  env.setHdr(false);
  surface.render(() => {});
  assert.equal(device.uniforms.at(-1)[0], 0);
  env.setHdr(true);
  assert.deepEqual(states, ['hdr', 'sdr', 'hdr']);
  assert.equal(env.devices.length, 1);
});

test('SDR override never enables extended canvas output, even on an HDR display', async () => {
  const env = setup();
  const surface = await env.api.createCanvas({ dynamicRange: 'sdr' });
  assert.equal(surface.getState().dynamicRange, 'sdr');
  assert.equal(env.canvases[0].ctx.config.toneMapping.mode, 'standard');
  env.setHdr(false);
  env.setHdr(true);
  assert.equal(surface.getState().reason, 'sdr-requested');
});

test('missing GPU or failed initialization returns an explicit Canvas2D fallback', async () => {
  for (const options of [{ gpu: false }, { failDevice: true }]) {
    const env = setup(options);
    const surface = await env.api.createCanvas();
    assert.equal(surface.getState().backend, 'canvas2d');
    assert.ok(surface.context2d);
    assert.equal(surface.device, null);
    assert.equal(
      surface.render(() => {
        throw new Error('must not run');
      }),
      false,
    );
    assert.throws(() => surface.start(() => {}));
    env.disposables[0]();
  }
});

test('resize preserves aspect ratio at the allocation limit and releases old textures', async () => {
  const env = setup();
  const surface = await env.api.createCanvas({ maxDimension: 512 });
  const oldTexture = env.devices[0].textures[0];
  surface.resize(1000, 500, 2);
  assert.equal(surface.canvas.width, 512);
  assert.equal(surface.canvas.height, 256);
  assert.equal(oldTexture.destroyed, true);
  surface.resize(NaN, 50);
  assert.equal(surface.canvas.width, 512);
});

test('unload stops animations, observers, subscriptions and disposes GPU resources exactly once', async () => {
  const env = setup();
  let calls = 0;
  env.api.onCapabilitiesChanged(() => {
    calls++;
  });
  await flush();
  const surface = await env.api.createCanvas();
  surface.start(() => {});
  assert.equal(env.animation.size, 1);
  env.disposables[0]();
  const before = calls;
  env.setHdr(false);
  await flush();
  assert.equal(calls, before);
  assert.equal(env.animation.size, 0);
  assert.ok(env.devices.every((d) => d.destroyed));
  assert.ok(env.observers.every((o) => o.disconnected));
  assert.equal(surface.getState().status, 'disposed');
  surface.dispose();
  await assert.rejects(env.api.createCanvas(), /已卸载/);
});

test('GPU device returned after unload is destroyed and never escapes to a plugin', async () => {
  const env = setup();
  const pending = deferred<any>();
  env.adapter.requestDevice = () => pending.promise;
  const promise = env.api.createCanvas();
  await flush();
  env.disposables[0]();
  let destroyed = false;
  pending.resolve({
    destroy() {
      destroyed = true;
    },
  });
  await assert.rejects(promise, /已卸载/);
  assert.equal(destroyed, true);
});

test('device loss stops drawing and tells the plugin to recreate its surface', async () => {
  const env = setup();
  const surface = await env.api.createCanvas();
  surface.start(() => {});
  env.devices[0].lose();
  await flush();
  assert.equal(surface.getState().status, 'lost');
  assert.equal(env.animation.size, 0);
  assert.equal(
    surface.render(() => {}),
    false,
  );
});

test('unsubscribed callbacks are not called after an asynchronous capability probe', async () => {
  const env = setup();
  let calls = 0;
  const off = env.api.onCapabilitiesChanged(() => {
    calls++;
  });
  off();
  await flush();
  env.setHdr(false);
  await flush();
  assert.equal(calls, 0);
});

test('a failed plugin frame is not submitted and its managed animation is stopped', async () => {
  const env = setup();
  const surface = await env.api.createCanvas();
  surface.start(() => {
    throw new Error('plugin failure');
  });
  const tick = env.animation.values().next().value!;
  env.animation.clear();
  tick();
  assert.equal(env.devices[0].submissions, 0);
  assert.equal(env.errors.length, 1);
  assert.equal(env.animation.size, 0);
});

test('SDR shoulder preserves midtones and monotonically compresses HDR peaks', () => {
  for (const value of [0, 0.1, 0.5, 0.75]) assert.equal(mapPluginSdrPeak(value), value);
  const peaks = [0.75, 1, 2, 4, 8, 16].map(mapPluginSdrPeak);
  assert.ok(peaks.every((value, i) => value < 1 && (!i || value > peaks[i - 1])));
});

test('configuration exceptions still balance the GPU error scope', async () => {
  let scopes = 0;
  const device = {
    pushErrorScope() {
      scopes++;
    },
    async popErrorScope() {
      scopes--;
      return null;
    },
  };
  const context = {
    configure() {
      throw new Error('unsupported');
    },
  };
  assert.equal(await configurePluginHdrCanvas(context as any, device as any, 'opaque'), false);
  assert.equal(scopes, 0);
});

test('2D fallback converts linear SDR values and HDR peaks to valid encoded CSS colors', () => {
  const { api } = setup({ gpu: false });
  assert.equal(api.toSdrColor({ r: 0, g: 0, b: 0 }), 'rgba(0, 0, 0, 1)');
  assert.equal(api.toSdrColor({ r: 0.5, g: 0.5, b: 0.5, a: 0.5 }), 'rgba(188, 188, 188, 0.5)');
  const channels = api
    .toSdrColor({ r: 4, g: 1, b: 0 })
    .match(/[\d.]+/g)!
    .map(Number);
  assert.ok(channels[0] > channels[1] && channels[1] > channels[2]);
  assert.ok(channels.every((v) => v >= 0 && v <= 255));
  assert.throws(() => api.toSdrColor({ r: NaN, g: 0, b: 0 }), /有限数字/);
});

test('static canvases redraw on HDR changes and invisible canvases skip GPU submission', async () => {
  const env = setup();
  const surface = await env.api.createCanvas();
  let frames = 0;
  surface.render(() => {
    frames++;
  });
  env.setHdr(false);
  assert.equal(frames, 2);
  assert.equal(env.devices[0].uniforms.at(-1)[0], 0);
  (surface.canvas as any).checkVisibility = () => false;
  assert.equal(
    surface.render(() => {
      frames++;
    }),
    false,
  );
  assert.equal(frames, 2);
});

test('an old animation stop function cannot stop a newer animation', async () => {
  const env = setup();
  const surface = await env.api.createCanvas();
  const stopOld = surface.start(() => {});
  const stopNew = surface.start(() => {});
  stopOld();
  assert.equal(env.animation.size, 1);
  stopNew();
  assert.equal(env.animation.size, 0);
});
