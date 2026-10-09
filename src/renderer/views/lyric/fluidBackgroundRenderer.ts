/**
 * Low-resolution fluid backdrop. All rotating cover tiles, displacement and blur
 * stay inside bounded render targets; the compositor only scales one canvas.
 * No screen-sized SVG/backdrop filters or per-frame pixel readbacks are needed.
 */
export const FLUID_RENDER_SIZE = 384;
export const FLUID_TEXTURE_SIZE = 200;
const NOISE_SIZE = 128;

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
const COMPOSE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uCover;
uniform sampler2D uNoise;
uniform vec2 uAspect;
uniform vec2 uContainerRotation;
uniform vec2 uTileRotation[4];
uniform float uWarp;
vec2 rotatePoint(vec2 p, vec2 rotation) {
  return vec2(rotation.x * p.x + rotation.y * p.y,
             -rotation.y * p.x + rotation.x * p.y);
}
void main() {
  vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uAspect;
  p = rotatePoint(p, uContainerRotation) / 1.2;
  float noise = texture2D(uNoise, p + 0.5).r - 0.5;
  p += vec2(noise * uWarp);
  vec3 color = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 tile = vec2(mod(float(i), 2.0), floor(float(i) / 2.0));
    vec2 center = (tile * 2.0 - 1.0) * 0.707 * 0.35;
    vec2 local = rotatePoint(p - center, uTileRotation[i]) / 0.707 + 0.5;
    float mask = step(0.0, local.x) * step(local.x, 1.0)
               * step(0.0, local.y) * step(local.y, 1.0);
    // Keep linear filtering within the selected quadrant of the cover atlas.
    vec2 uv = (tile + clamp(local, 0.005, 0.995)) * 0.5;
    vec4 pixel = texture2D(uCover, uv);
    color = mix(color, pixel.rgb, pixel.a * mask);
  }
  gl_FragColor = vec4(color, 1.0);
}`;
// A wider Gaussian kernel avoids repeated tile silhouettes on small windows.
// Generate constant sample positions/weights once, rather than calculating them
// per fragment or allocating arrays in the draw loop.
const blurWeights = Array.from({ length: 9 }, (_, i) => Math.exp(-(i * i) / 18));
const blurWeightSum = blurWeights[0] + 2 * blurWeights.slice(1).reduce((a, b) => a + b, 0);
const BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uStep;
uniform float uFinish;
void main() {
  vec3 color = texture2D(uSource, vUv).rgb * ${(blurWeights[0] / blurWeightSum).toFixed(10)};
  ${blurWeights
    .slice(1)
    .map(
      (weight, i) => `
  color += texture2D(uSource, vUv + uStep * ${i + 1}.0).rgb * ${(weight / blurWeightSum).toFixed(10)};
  color += texture2D(uSource, vUv - uStep * ${i + 1}.0).rgb * ${(weight / blurWeightSum).toFixed(10)};`,
    )
    .join('')}
  if (uFinish > 0.5) {
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = clamp(mix(vec3(luminance), color, 1.3) * 1.5, 0.0, 1.0) * 0.76;
  }
  gl_FragColor = vec4(color, 1.0);
}`;

export function fluidRenderDimensions(width: number, height: number) {
  const scale = Math.min(1, FLUID_RENDER_SIZE / Math.max(1, width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function seedFromUrl(value: string) {
  let seed = 0;
  for (let i = 0; i < value.length; i++) seed = (seed * 31 + value.charCodeAt(i)) >>> 0;
  return seed;
}

// The noise field depends on cover and layout, never on animation frames.
function createNoise(seed: number, size: number) {
  const pixels = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
  const frequency = size * 0.005;
  const gradient = (x: number, y: number, dx: number, dy: number) => {
    const hash = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed) >>> 0;
    const angle = ((hash ^ (hash >>> 13)) & 255) * (Math.PI / 128);
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  const fade = (n: number) => n * n * n * (n * (n * 6 - 15) + 10);
  for (let y = 0; y < NOISE_SIZE; y++) {
    const py = (y / (NOISE_SIZE - 1)) * frequency;
    const iy = Math.floor(py),
      dy = py - iy,
      fy = fade(dy);
    for (let x = 0; x < NOISE_SIZE; x++) {
      const px = (x / (NOISE_SIZE - 1)) * frequency;
      const ix = Math.floor(px),
        dx = px - ix,
        fx = fade(dx);
      const a = gradient(ix, iy, dx, dy);
      const b = gradient(ix + 1, iy, dx - 1, dy);
      const c = gradient(ix, iy + 1, dx, dy - 1);
      const d = gradient(ix + 1, iy + 1, dx - 1, dy - 1);
      const value = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      pixels[y * NOISE_SIZE + x] = Math.round(Math.max(0, Math.min(1, 0.5 + value * 0.7)) * 255);
    }
  }
  return pixels;
}

export class FluidBackgroundRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly textures: WebGLTexture[] = [];
  private readonly programs: WebGLProgram[] = [];
  private readonly targets: WebGLFramebuffer[] = [];
  private readonly rotations = new Float32Array(8);
  private buffer: WebGLBuffer | null = null;
  private compose!: WebGLProgram;
  private blur!: WebGLProgram;
  private cover!: WebGLTexture;
  private noise!: WebGLTexture;
  private composed!: WebGLTexture;
  private blurred!: WebGLTexture;
  private composePosition = 0;
  private blurPosition = 0;
  private locations!: Record<string, WebGLUniformLocation | null>;
  private cssWidth = 1;
  private cssHeight = 1;
  private targetWidth = 0;
  private targetHeight = 0;
  private seed = 0;
  private noiseKey = '';
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL is unavailable');
    this.gl = gl;
    try {
      this.compose = this.program(COMPOSE);
      this.blur = this.program(BLUR);
      this.composePosition = gl.getAttribLocation(this.compose, 'aPosition');
      this.blurPosition = gl.getAttribLocation(this.blur, 'aPosition');
      this.locations = {};
      for (const name of [
        'uCover',
        'uNoise',
        'uAspect',
        'uContainerRotation',
        'uTileRotation[0]',
        'uWarp',
      ])
        this.locations[name] = gl.getUniformLocation(this.compose, name);
      for (const name of ['uSource', 'uStep', 'uFinish'])
        this.locations[name] = gl.getUniformLocation(this.blur, name);
      this.buffer = gl.createBuffer();
      if (!this.buffer) throw new Error('Unable to allocate background geometry');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      this.cover = this.texture();
      this.noise = this.texture();
      this.composed = this.texture();
      this.blurred = this.texture();
      for (const texture of [this.composed, this.blurred]) {
        const target = gl.createFramebuffer();
        if (!target) throw new Error('Unable to allocate background target');
        this.targets.push(target);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private program(fragmentSource: string) {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error('Unable to allocate background shader');
    this.programs.push(program);
    const shaders: WebGLShader[] = [];
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, fragmentSource],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Unable to allocate background shader');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || 'Background shader compilation failed');
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) || 'Background shader linking failed');
      return program;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  private texture() {
    const gl = this.gl,
      texture = gl.createTexture();
    if (!texture) throw new Error('Unable to allocate background texture');
    this.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  resize(width: number, height: number) {
    if (this.disposed) return;
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    const dimensions = fluidRenderDimensions(this.cssWidth, this.cssHeight);
    const gl = this.gl;
    if (this.targetWidth !== dimensions.width || this.targetHeight !== dimensions.height) {
      this.canvas.width = dimensions.width;
      this.canvas.height = dimensions.height;
      for (let i = 0; i < 2; i++) {
        gl.bindTexture(gl.TEXTURE_2D, i === 0 ? this.composed : this.blurred);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          dimensions.width,
          dimensions.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[i]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error('Incomplete background render target');
      }
      this.targetWidth = dimensions.width;
      this.targetHeight = dimensions.height;
    }
    this.updateNoise();
  }

  private updateNoise() {
    // Tiny resize steps needn't regenerate a whole noise texture.
    const size = Math.max(64, Math.round(Math.max(this.cssWidth, this.cssHeight) / 64) * 64);
    const key = `${this.seed}:${size}`;
    if (key === this.noiseKey) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      NOISE_SIZE,
      NOISE_SIZE,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      createNoise(this.seed, size),
    );
    this.noiseKey = key;
  }

  setCover(image: HTMLImageElement, url: string) {
    if (this.disposed) return;
    const atlas = document.createElement('canvas');
    atlas.width = atlas.height = FLUID_TEXTURE_SIZE;
    const context = atlas.getContext('2d');
    if (!context) throw new Error('Unable to prepare background cover');
    const tileSize = FLUID_TEXTURE_SIZE / 2;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    try {
      for (let i = 0; i < 4; i++) {
        const x = (i % 2) * tileSize,
          y = Math.floor(i / 2) * tileSize;
        context.save();
        context.beginPath();
        context.rect(x, y, tileSize, tileSize);
        context.clip();
        context.filter = 'blur(5px)';
        context.drawImage(
          image,
          ((i % 2) * width) / 2,
          (Math.floor(i / 2) * height) / 2,
          width / 2,
          height / 2,
          x,
          y,
          tileSize,
          tileSize,
        );
        context.restore();
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.cover);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      this.seed = seedFromUrl(url);
      this.updateNoise();
    } finally {
      // Release the decoded staging surface immediately after its upload.
      atlas.width = atlas.height = 1;
    }
  }

  draw(seconds: number) {
    if (this.disposed) return;
    const gl = this.gl,
      size = Math.max(this.cssWidth, this.cssHeight);
    const angle = (-(seconds % 150) * Math.PI * 2) / 150;
    for (let i = 0; i < 4; i++) {
      const tileAngle = (((seconds + i * 5) % 60) * Math.PI * 2) / 60;
      this.rotations[i * 2] = Math.cos(tileAngle);
      this.rotations[i * 2 + 1] = Math.sin(tileAngle);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.useProgram(this.compose);
    gl.enableVertexAttribArray(this.composePosition);
    gl.vertexAttribPointer(this.composePosition, 2, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cover);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.uniform1i(this.locations.uCover, 0);
    gl.uniform1i(this.locations.uNoise, 1);
    gl.uniform2f(this.locations.uAspect, this.cssWidth / size, this.cssHeight / size);
    gl.uniform2f(this.locations.uContainerRotation, Math.cos(angle), Math.sin(angle));
    gl.uniform2fv(this.locations['uTileRotation[0]'], this.rotations);
    gl.uniform1f(this.locations.uWarp, 400 / size);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.useProgram(this.blur);
    gl.enableVertexAttribArray(this.blurPosition);
    gl.vertexAttribPointer(this.blurPosition, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.locations.uSource, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[1]);
    gl.bindTexture(gl.TEXTURE_2D, this.composed);
    gl.uniform2f(this.locations.uStep, 64 / this.cssWidth / 3, 0);
    gl.uniform1f(this.locations.uFinish, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.blurred);
    gl.uniform2f(this.locations.uStep, 0, 64 / this.cssHeight / 3);
    gl.uniform1f(this.locations.uFinish, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const texture of this.textures) gl.deleteTexture(texture);
    for (const target of this.targets) gl.deleteFramebuffer(target);
    for (const program of this.programs) gl.deleteProgram(program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.textures.length = this.targets.length = this.programs.length = 0;
    this.buffer = null;
    this.canvas.width = this.canvas.height = 1;
    // A removed canvas needn't retain a driver context until the next GC cycle.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
