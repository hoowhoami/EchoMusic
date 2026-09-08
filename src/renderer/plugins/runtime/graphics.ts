/// <reference types="@webgpu/types" />

export interface PluginGraphicsCapabilities {
  webgpu: boolean;
  /** The GPU canvas accepted rgba16float + extended tone mapping. */
  hdrCanvas: boolean;
  /** Browser-reported display capability, not a measurement of current HDR brightness. */
  displayHighDynamicRange: boolean;
  colorGamut: 'srgb' | 'p3' | 'rec2020';
  hdrEligible: boolean;
  outputVerification: 'unverified';
  reason: string | null;
}

export interface PluginGraphicsCanvasOptions {
  dynamicRange?: 'auto' | 'sdr';
  alphaMode?: 'opaque' | 'premultiplied';
  /** Maximum backing-store dimension, default 4096, also limited by the GPU. */
  maxDimension?: number;
}

export interface PluginGraphicsCanvasState {
  backend: 'webgpu' | 'canvas2d';
  status: 'ready' | 'lost' | 'disposed';
  dynamicRange: 'hdr' | 'sdr';
  reason: string | null;
  outputVerification: 'unverified';
}

export interface PluginGraphicsFrame {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  /** Linear sRGB, straight alpha. 1 is SDR reference white; values >1 are highlights. */
  view: GPUTextureView;
  format: 'rgba16float';
  width: number;
  height: number;
  time: number;
}

export interface PluginGraphicsCanvas {
  canvas: HTMLCanvasElement;
  device: GPUDevice | null;
  context2d: CanvasRenderingContext2D | null;
  getState(): PluginGraphicsCanvasState;
  onStateChanged(callback: (state: PluginGraphicsCanvasState) => void): () => void;
  /** CSS pixels. With no arguments, read the canvas's current layout size. */
  resize(width?: number, height?: number, pixelRatio?: number): void;
  /** Synchronous drawing only. Host submits commands and converts linear colors for display. */
  render(draw: (frame: PluginGraphicsFrame) => void): boolean;
  /** Start a managed WebGPU animation loop; returns a stop function. */
  start(draw: (frame: PluginGraphicsFrame) => void): () => void;
  dispose(): void;
}

export interface PluginGraphicsApi {
  /** Match the host's SDR tone mapping when drawing a Canvas2D fallback. */
  toSdrColor(color: { r: number; g: number; b: number; a?: number }): string;
  getCapabilities(options?: { refresh?: boolean }): Promise<PluginGraphicsCapabilities>;
  onCapabilitiesChanged(callback: (capabilities: PluginGraphicsCapabilities) => void): () => void;
  createCanvas(options?: PluginGraphicsCanvasOptions): Promise<PluginGraphicsCanvas>;
}

interface GraphicsDeps {
  addDisposable(dispose: () => void): unknown;
  runCallback(source: string, callback: () => void): void;
}

// Smooth SDR shoulder. Keep low/mid values unchanged, compress bright values
// into SDR instead of clipping all HDR highlights to white. Applied only to the
// plugin canvas, never the host DOM or other canvases.
export function mapPluginSdrPeak(peak: number): number {
  return peak <= 0.75 ? Math.max(0, peak) : 0.75 + (0.25 * (peak - 0.75)) / (peak - 0.5);
}

export function pluginLinearColorToSdr(color: {
  r: number;
  g: number;
  b: number;
  a?: number;
}): string {
  const alpha = color.a ?? 1;
  if (![color.r, color.g, color.b, alpha].every(Number.isFinite))
    throw new TypeError('颜色分量必须是有限数字');
  const rgb = [color.r, color.g, color.b].map((value) => Math.max(0, Math.min(65504, value)));
  const peak = Math.max(...rgb);
  const scale = peak > 0 ? mapPluginSdrPeak(peak) / peak : 1;
  const encoded = rgb.map((value) => {
    const linear = value * scale;
    return Math.round(
      255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055),
    );
  });
  return `rgba(${encoded.join(', ')}, ${Math.max(0, Math.min(1, alpha))})`;
}

export const PLUGIN_GRAPHICS_PRESENT_SHADER = `
struct Options { hdr: f32, premultiplied: f32, padding: vec2f }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> options: Options;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let sample = textureLoad(source, vec2i(position.xy), 0);
  var rgb = clamp(sample.rgb, vec3f(0.0), vec3f(65504.0));
  if (options.hdr < 0.5) {
    let peak = max(rgb.r, max(rgb.g, rgb.b));
    if (peak > 0.75) {
      let mapped = 0.75 + 0.25 * (peak - 0.75) / (peak - 0.5);
      rgb *= mapped / peak;
    }
  }
  // The canvas is configured as sRGB, so encode linear plugin output once.
  rgb = select(1.055 * pow(rgb, vec3f(1.0 / 2.4)) - 0.055,
               12.92 * rgb, rgb <= vec3f(0.0031308));
  var alpha = 1.0;
  if (options.premultiplied > 0.5) {
    alpha = clamp(sample.a, 0.0, 1.0);
    rgb *= alpha;
  }
  return vec4f(rgb, alpha);
}`;

/** Uses real configuration readback + validation, not just presence of WebGPU. */
export async function configurePluginHdrCanvas(
  context: GPUCanvasContext,
  device: GPUDevice,
  alphaMode: GPUCanvasAlphaMode,
): Promise<boolean> {
  device.pushErrorScope('validation');
  let accepted = false;
  try {
    context.configure({
      device,
      format: 'rgba16float',
      colorSpace: 'srgb',
      alphaMode,
      toneMapping: { mode: 'extended' },
    });
    const config = context.getConfiguration();
    accepted = config?.format === 'rgba16float' && config.toneMapping?.mode === 'extended';
  } catch {
    accepted = false;
  }
  const error = await device.popErrorScope();
  return accepted && !error;
}

export function createPluginGraphicsApi(deps: GraphicsDeps): PluginGraphicsApi {
  let disposed = false;
  let watching = false;
  let probe: Promise<{ webgpu: boolean; hdrCanvas: boolean; reason: string | null }> | null = null;
  const callbacks = new Set<(caps: PluginGraphicsCapabilities) => void>();
  const surfaces = new Set<{ refresh(): void; dispose(): void }>();
  const cleanupEvents: Array<() => void> = [];
  let lastCapabilities = '';
  let notificationRevision = 0;
  const media = (query: string) => window.matchMedia(query).matches;
  const assertActive = () => {
    if (disposed) throw new Error('插件图形接口已卸载');
  };

  const probeGpu = async () => {
    if (!navigator.gpu) return { webgpu: false, hdrCanvas: false, reason: 'webgpu-unavailable' };
    let device: GPUDevice | undefined;
    let context: GPUCanvasContext | null = null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { webgpu: false, hdrCanvas: false, reason: 'adapter-unavailable' };
      assertActive();
      device = await adapter.requestDevice();
      assertActive();
      context = document.createElement('canvas').getContext('webgpu');
      const hdrCanvas = !!context && (await configurePluginHdrCanvas(context, device, 'opaque'));
      return { webgpu: true, hdrCanvas, reason: hdrCanvas ? null : 'hdr-canvas-unavailable' };
    } catch {
      return { webgpu: false, hdrCanvas: false, reason: 'gpu-initialization-failed' };
    } finally {
      context?.unconfigure();
      device?.destroy();
    }
  };

  const getCapabilities = async (options?: {
    refresh?: boolean;
  }): Promise<PluginGraphicsCapabilities> => {
    assertActive();
    if (options?.refresh) probe = null;
    const gpu = await (probe ??= probeGpu());
    assertActive();
    const displayHighDynamicRange = media('(dynamic-range: high)');
    return {
      ...gpu,
      displayHighDynamicRange,
      colorGamut: media('(color-gamut: rec2020)')
        ? 'rec2020'
        : media('(color-gamut: p3)')
          ? 'p3'
          : 'srgb',
      hdrEligible: gpu.hdrCanvas && displayHighDynamicRange,
      outputVerification: 'unverified',
      reason: gpu.reason ?? (displayHighDynamicRange ? null : 'display-reports-sdr'),
    };
  };
  const notify = () => {
    if (disposed) return;
    for (const surface of surfaces) surface.refresh();
    if (!callbacks.size) return;
    const revision = ++notificationRevision;
    void getCapabilities()
      .then((caps) => {
        if (disposed || revision !== notificationRevision) return;
        const key = JSON.stringify(caps);
        if (key === lastCapabilities) return;
        lastCapabilities = key;
        for (const callback of callbacks)
          deps.runCallback('图形能力变化', () => callback({ ...caps }));
      })
      .catch(() => {});
  };
  const watchEnvironment = () => {
    if (watching) return;
    watching = true;
    for (const query of ['(dynamic-range: high)', '(color-gamut: p3)', '(color-gamut: rec2020)']) {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      cleanupEvents.push(() => list.removeEventListener('change', notify));
    }
    for (const event of ['resize', 'focus', 'pageshow']) {
      window.addEventListener(event, notify);
      cleanupEvents.push(() => window.removeEventListener(event, notify));
    }
    document.addEventListener('visibilitychange', notify);
    cleanupEvents.push(() => document.removeEventListener('visibilitychange', notify));
  };
  deps.addDisposable(() => {
    disposed = true;
    for (const surface of [...surfaces]) surface.dispose();
    callbacks.clear();
    for (const off of cleanupEvents) off();
  });

  return {
    toSdrColor: pluginLinearColorToSdr,
    getCapabilities,
    onCapabilitiesChanged(callback) {
      assertActive();
      watchEnvironment();
      callbacks.add(callback);
      void getCapabilities()
        .then((caps) => {
          if (!disposed && callbacks.has(callback)) {
            lastCapabilities = JSON.stringify(caps);
            deps.runCallback('图形能力初始状态', () => callback(caps));
          }
        })
        .catch(() => {});
      return () => {
        callbacks.delete(callback);
      };
    },
    async createCanvas(options = {}) {
      assertActive();
      if (options.dynamicRange !== undefined && !['auto', 'sdr'].includes(options.dynamicRange)) {
        throw new TypeError('dynamicRange 必须是 auto 或 sdr');
      }
      const alphaMode = options.alphaMode ?? 'opaque';
      if (!['opaque', 'premultiplied'].includes(alphaMode)) throw new TypeError('无效的 alphaMode');
      watchEnvironment();
      let canvas = document.createElement('canvas');
      let device: GPUDevice | null = null;
      let context: GPUCanvasContext | null = null;
      let context2d: CanvasRenderingContext2D | null = null;
      let hdrCanvas = false;
      let format: GPUTextureFormat = 'bgra8unorm';
      let pipeline: GPURenderPipeline | null = null;
      let uniform: GPUBuffer | null = null;
      let source: GPUTexture | null = null;
      let bindGroup: GPUBindGroup | null = null;
      let reason: string | null = null;
      try {
        const adapter = await navigator.gpu?.requestAdapter();
        assertActive();
        if (adapter) {
          device = await adapter.requestDevice();
          assertActive();
          context = canvas.getContext('webgpu');
          if (!context) throw new Error('WebGPU canvas unavailable');
          if (options.dynamicRange !== 'sdr')
            hdrCanvas = await configurePluginHdrCanvas(context, device, alphaMode);
          assertActive();
          format = hdrCanvas ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
          if (!hdrCanvas)
            context.configure({
              device,
              format,
              colorSpace: 'srgb',
              alphaMode,
              toneMapping: { mode: 'standard' },
            });
          const module = device.createShaderModule({ code: PLUGIN_GRAPHICS_PRESENT_SHADER });
          pipeline = await device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertex' },
            fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
          });
          assertActive();
          uniform = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
        } else reason = navigator.gpu ? 'adapter-unavailable' : 'webgpu-unavailable';
      } catch {
        reason = 'gpu-initialization-failed';
        context?.unconfigure();
        device?.destroy();
        device = null;
        context = null;
      }
      assertActive();
      if (!device) {
        // A canvas cannot switch from a GPU context to a 2D context.
        canvas = document.createElement('canvas');
        context2d = canvas.getContext('2d', { alpha: alphaMode !== 'opaque', colorSpace: 'srgb' });
        if (!context2d) throw new Error('无法创建 SDR 画布');
      }
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      canvas.width = canvas.height = 1;
      const requestedLimit = Number(options.maxDimension ?? 4096);
      const maxDimension = Math.min(
        device?.limits.maxTextureDimension2D ?? 4096,
        Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(8192, Math.floor(requestedLimit)))
          : 4096,
      );
      let state: PluginGraphicsCanvasState = {
        backend: device ? 'webgpu' : 'canvas2d',
        status: 'ready',
        dynamicRange: 'sdr',
        reason,
        outputVerification: 'unverified',
      };
      const listeners = new Set<(state: PluginGraphicsCanvasState) => void>();
      let animation: number | null = null;
      let animationGeneration = 0;
      let redraw: (() => void) | null = null;
      const emit = () => {
        for (const callback of listeners)
          deps.runCallback('图形画布状态', () => callback({ ...state }));
      };
      const stop = () => {
        animationGeneration++;
        if (animation !== null) window.cancelAnimationFrame(animation);
        animation = null;
      };
      const resize = (
        width = canvas.clientWidth,
        height = canvas.clientHeight,
        ratio = window.devicePixelRatio,
      ) => {
        if (state.status !== 'ready') return false;
        if (
          ![width, height, ratio].every(Number.isFinite) ||
          width <= 0 ||
          height <= 0 ||
          ratio <= 0
        )
          return false;
        const scale = Math.min(ratio, maxDimension / width, maxDimension / height);
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        if (canvas.width === w && canvas.height === h && (!device || source)) return false;
        canvas.width = w;
        canvas.height = h;
        source?.destroy();
        if (device && pipeline && uniform) {
          source = device.createTexture({
            size: [w, h],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: source.createView() },
              { binding: 1, resource: { buffer: uniform } },
            ],
          });
        }
        return true;
      };
      const refresh = () => {
        if (state.status !== 'ready') return;
        const hdr =
          !!device && hdrCanvas && options.dynamicRange !== 'sdr' && media('(dynamic-range: high)');
        const nextReason = !device
          ? reason
          : options.dynamicRange === 'sdr'
            ? 'sdr-requested'
            : !hdrCanvas
              ? 'hdr-canvas-unavailable'
              : !hdr
                ? 'display-reports-sdr'
                : null;
        const changed = state.dynamicRange !== (hdr ? 'hdr' : 'sdr') || state.reason !== nextReason;
        if (changed) {
          state = { ...state, dynamicRange: hdr ? 'hdr' : 'sdr', reason: nextReason };
          emit();
        }
        const resized = resize();
        if (changed || resized) redraw?.();
      };
      const observer = new ResizeObserver(() => {
        if (resize()) redraw?.();
      });
      observer.observe(canvas);
      const lifecycle = {
        refresh,
        dispose: () => {
          if (state.status === 'disposed') return;
          stop();
          observer.disconnect();
          source?.destroy();
          uniform?.destroy();
          context?.unconfigure();
          device?.destroy();
          canvas.remove();
          state = { ...state, status: 'disposed' };
          redraw = null;
          listeners.clear();
          surfaces.delete(lifecycle);
        },
      };
      surfaces.add(lifecycle);
      refresh();
      if (device)
        void device.lost.then(() => {
          if (state.status !== 'ready') return;
          stop();
          state = { ...state, status: 'lost', dynamicRange: 'sdr', reason: 'device-lost' };
          probe = null;
          emit();
          notify();
        });
      const surface: PluginGraphicsCanvas = {
        canvas,
        device,
        context2d,
        getState: () => ({ ...state }),
        onStateChanged(callback) {
          if (state.status === 'disposed') throw new Error('画布已释放');
          listeners.add(callback);
          deps.runCallback('图形画布初始状态', () => callback({ ...state }));
          return () => {
            listeners.delete(callback);
          };
        },
        resize,
        render(draw) {
          if (
            state.status !== 'ready' ||
            !device ||
            !context ||
            !pipeline ||
            !uniform ||
            document.hidden ||
            !canvas.isConnected
          )
            return false;
          if (
            canvas.checkVisibility &&
            !canvas.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
          )
            return false;
          redraw = () =>
            deps.runCallback('图形画布重绘', () => {
              surface.render(draw);
            });
          resize();
          if (!source || !bindGroup || canvas.clientWidth <= 0 || canvas.clientHeight <= 0)
            return false;
          const encoder = device.createCommandEncoder();
          const view = source.createView();
          encoder
            .beginRenderPass({
              colorAttachments: [
                { view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
              ],
            })
            .end();
          let completed = false;
          deps.runCallback('图形画布绘制', () => {
            const result: unknown = draw({
              device: device!,
              encoder,
              view,
              format: 'rgba16float',
              width: canvas.width,
              height: canvas.height,
              time: performance.now(),
            });
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              void Promise.resolve(result).catch(() => {});
              throw new Error('render 回调必须同步完成');
            }
            completed = true;
          });
          if (!completed) stop();
          if (!completed || state.status !== 'ready') return false;
          device.queue.writeBuffer(
            uniform,
            0,
            new Float32Array([
              state.dynamicRange === 'hdr' ? 1 : 0,
              alphaMode === 'premultiplied' ? 1 : 0,
              0,
              0,
            ]),
          );
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                loadOp: 'clear',
                clearValue: [0, 0, 0, 0],
                storeOp: 'store',
              },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          return true;
        },
        start(draw) {
          if (!device || state.status !== 'ready') throw new Error('当前画布不能启动 WebGPU 动画');
          stop();
          const generation = animationGeneration;
          const tick = () => {
            if (generation !== animationGeneration || state.status !== 'ready') return;
            let completed = false;
            deps.runCallback('图形动画', () => {
              surface.render(draw);
              completed = true;
            });
            if (!completed) stop();
            if (generation !== animationGeneration || state.status !== 'ready') return;
            // Hidden/detached canvases skip GPU work; browser RAF also pauses in the background.
            animation = window.requestAnimationFrame(tick);
          };
          animation = window.requestAnimationFrame(tick);
          return () => {
            if (generation === animationGeneration) stop();
          };
        },
        dispose: lifecycle.dispose,
      };
      return surface;
    },
  };
}
