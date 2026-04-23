/**
 * MKV 音轨提取 — 基于 Electron 自定义协议
 *
 * 注册 mkv-extract:// 协议，渲染进程通过
 * <audio src="mkv-extract://extract?track=1&url=..."> 播放。
 *
 * MKV (Matroska) 使用 EBML 二进制格式，结构为嵌套的 Element：
 *   [Element ID (VINT)] [Data Size (VINT)] [Data...]
 *
 * 我们只需要关心：
 *   - EBML Header (0x1A45DFA3)
 *   - Segment (0x18538067)
 *     - Tracks (0x1654AE6B) → TrackEntry (0xAE) → TrackNumber (0xD7)
 *     - Cluster (0x1F43B675) → SimpleBlock (0xA3) → 提取目标音轨的帧数据
 */

import { net, protocol } from 'electron';

// ── EBML Element ID 常量 ──
const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CLUSTER = 0x1f43b675;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;

// 音轨类型
const TRACK_TYPE_AUDIO = 2;

// ── EBML VINT 解析 ──

/** 读取 VINT（Variable-size Integer），返回值和消耗的字节数 */
function readVINT(buf: Uint8Array, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;

  let len = 0;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) {
      len = i + 1;
      break;
    }
  }
  if (offset + len > buf.length) return null;

  let value = first & ((0x80 >> (len - 1)) - 1);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[offset + i];
  }
  return { value, length: len };
}

/** 读取 Element ID（保留前导位标记） */
function readElementID(buf: Uint8Array, offset: number): { id: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;

  let len = 0;
  for (let i = 0; i < 4; i++) {
    if (first & (0x80 >> i)) {
      len = i + 1;
      break;
    }
  }
  if (len === 0 || offset + len > buf.length) return null;

  let id = first;
  for (let i = 1; i < len; i++) {
    id = id * 256 + buf[offset + i];
  }
  return { id, length: len };
}

/** 读取无符号整数（用于 TrackNumber 等） */
function readUInt(buf: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + buf[offset + i];
  }
  return value;
}

// ── 流式 MKV 解析器 ──

/** 已知的 Master Element ID（包含子元素的容器） */
const MASTER_ELEMENTS = new Set([
  ID_SEGMENT,
  ID_TRACKS,
  ID_TRACK_ENTRY,
  ID_CLUSTER,
  ID_BLOCK_GROUP,
  0x1a45dfa3, // EBML Header
  0x1549a966, // Segment Info
  0x1254c367, // Tags
  0x1c53bb6b, // Cues
]);

interface AudioTrackInfo {
  trackNumber: number;
  trackType: number;
}

interface ExtractOptions {
  /** 目标音轨序号（从 1 开始，对应 MKV 中的 TrackNumber） */
  targetTrack: number;
  /** 数据回调，每提取到一帧就调用 */
  onData: (chunk: Uint8Array) => void;
  /** 音轨信息回调，解析到 Tracks 后调用 */
  onTrackInfo?: (tracks: AudioTrackInfo[]) => void;
  /** 完成回调 */
  onEnd: () => void;
  /** 错误回调 */
  onError: (err: Error) => void;
}

/**
 * 创建流式 MKV 解析器
 * 调用 feed() 喂入数据块，解析器会自动提取目标音轨的帧数据
 */
function createMkvStreamParser(options: ExtractOptions) {
  const { targetTrack, onData, onTrackInfo, onEnd, onError } = options;

  // 内部缓冲区
  let buffer = new Uint8Array(0);
  const audioTracks: AudioTrackInfo[] = [];
  let headerParsed = false;
  let destroyed = false;

  // 解析状态栈：跟踪当前在哪个 Master Element 内部
  // 每个条目记录 [elementId, 剩余可读字节数]
  const stack: Array<{ id: number; remaining: number }> = [];

  // 当前正在解析的 TrackEntry 临时数据
  let currentTrackNumber = 0;
  let currentTrackType = 0;
  let inTrackEntry = false;

  function appendBuffer(chunk: Uint8Array) {
    const newBuf = new Uint8Array(buffer.length + chunk.length);
    newBuf.set(buffer);
    newBuf.set(chunk, buffer.length);
    buffer = newBuf;
  }

  function consumeBytes(n: number) {
    // 更新栈中所有层级的剩余字节数
    for (const entry of stack) {
      if (entry.remaining >= 0) {
        entry.remaining -= n;
      }
    }
    buffer = buffer.slice(n);
  }

  // 检查并弹出已经读完的栈帧
  function popCompletedFrames() {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.remaining <= 0) {
        if (top.id === ID_TRACK_ENTRY && inTrackEntry) {
          // TrackEntry 结束，记录音轨信息
          if (currentTrackType === TRACK_TYPE_AUDIO) {
            audioTracks.push({
              trackNumber: currentTrackNumber,
              trackType: currentTrackType,
            });
          }
          inTrackEntry = false;
          currentTrackNumber = 0;
          currentTrackType = 0;
        }
        if (top.id === ID_TRACKS && !headerParsed) {
          headerParsed = true;
          onTrackInfo?.(audioTracks);
        }
        stack.pop();
      } else {
        break;
      }
    }
  }

  function parse() {
    if (destroyed) return;

    while (buffer.length > 0) {
      popCompletedFrames();

      // 读取 Element ID
      const idResult = readElementID(buffer, 0);
      if (!idResult) break;

      // 读取 Data Size
      const sizeResult = readVINT(buffer, idResult.length);
      if (!sizeResult) break;

      const elementId = idResult.id;
      const dataSize = sizeResult.value;
      const headerSize = idResult.length + sizeResult.length;

      // 检查是否是 "unknown size"（全 1）
      const isUnknownSize = dataSize === (1 << (7 * sizeResult.length)) - 1;

      if (MASTER_ELEMENTS.has(elementId)) {
        consumeBytes(headerSize);
        stack.push({
          id: elementId,
          remaining: isUnknownSize ? Number.MAX_SAFE_INTEGER : dataSize,
        });

        if (elementId === ID_TRACK_ENTRY) {
          inTrackEntry = true;
          currentTrackNumber = 0;
          currentTrackType = 0;
        }
        continue;
      }

      // 非 Master Element：需要完整数据
      const totalSize = headerSize + dataSize;
      if (buffer.length < totalSize) break;

      // 处理特定元素
      if (elementId === ID_TRACK_NUMBER && inTrackEntry) {
        currentTrackNumber = readUInt(buffer, headerSize, dataSize);
      } else if (elementId === ID_TRACK_TYPE && inTrackEntry) {
        currentTrackType = readUInt(buffer, headerSize, dataSize);
      } else if (elementId === ID_SIMPLE_BLOCK) {
        // SimpleBlock: [TrackNumber (VINT)] [Timecode (int16)] [Flags (uint8)] [Frame Data...]
        const trackVint = readVINT(buffer, headerSize);
        if (trackVint && trackVint.value === targetTrack) {
          const frameOffset = headerSize + trackVint.length + 3;
          const frameData = buffer.slice(frameOffset, headerSize + dataSize);
          if (frameData.length > 0) {
            onData(frameData);
          }
        }
      } else if (elementId === ID_BLOCK) {
        const trackVint = readVINT(buffer, headerSize);
        if (trackVint && trackVint.value === targetTrack) {
          const frameOffset = headerSize + trackVint.length + 3;
          const frameData = buffer.slice(frameOffset, headerSize + dataSize);
          if (frameData.length > 0) {
            onData(frameData);
          }
        }
      }

      consumeBytes(totalSize);
    }
  }

  return {
    feed(chunk: Uint8Array) {
      if (destroyed) return;
      appendBuffer(chunk);
      try {
        parse();
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    end() {
      if (destroyed) return;
      destroyed = true;
      try {
        parse();
      } catch {
        // 忽略尾部解析错误
      }
      onEnd();
    },
    destroy() {
      destroyed = true;
      buffer = new Uint8Array(0);
      stack.length = 0;
    },
  };
}

// ── 自定义协议 ──

export const MKV_EXTRACT_SCHEME = 'mkv-extract';

/**
 * 注册 mkv-extract:// 自定义协议（必须在 app.ready 之前调用）
 */
export function registerMkvExtractScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MKV_EXTRACT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

/**
 * 注册协议处理器（必须在 app.ready 之后调用）
 */
export function registerMkvExtractHandler(): void {
  protocol.handle(MKV_EXTRACT_SCHEME, async (request) => {
    const url = new URL(request.url);
    const mkvUrl = url.searchParams.get('url');
    const trackStr = url.searchParams.get('track');
    const hash = url.searchParams.get('hash');
    const sizeStr = url.searchParams.get('size');

    if (!mkvUrl || !trackStr) {
      return new Response('Missing url or track parameter', { status: 400 });
    }

    const targetTrack = parseInt(trackStr, 10);
    if (isNaN(targetTrack) || targetTrack < 1) {
      return new Response('Invalid track number', { status: 400 });
    }

    // 用 hash#track 做缓存 key，避免 CDN URL 变化导致缓存失效
    const cacheKey = `${hash || mkvUrl}#${targetTrack}`;
    const cached = extractCache.get(cacheKey);

    // ── 缓存命中：精确 Content-Length + Range 支持 ──
    if (cached) {
      const totalSize = cached.length;
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
          const sliceLen = end + 1 - start;
          const sliced = Buffer.from(cached).buffer.slice(start, start + sliceLen) as ArrayBuffer;
          return new Response(sliced, {
            status: 206,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Content-Length': String(sliceLen),
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'Accept-Ranges': 'bytes',
            },
          });
        }
      }
      const body = Buffer.from(cached).buffer.slice(0, totalSize) as ArrayBuffer;
      return new Response(body, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(totalSize),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    // ── 缓存未命中：检查是否正在提取中 ──
    const pending = pendingExtracts.get(cacheKey);
    if (pending) {
      // 等待正在进行的提取完成，然后从缓存返回
      const data = await pending;
      if (data) {
        const totalSize = data.length;
        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (match) {
            const start = parseInt(match[1], 10);
            const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
            const sliceLen = end + 1 - start;
            const sliced = Buffer.from(data).buffer.slice(start, start + sliceLen) as ArrayBuffer;
            return new Response(sliced, {
              status: 206,
              headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': String(sliceLen),
                'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                'Accept-Ranges': 'bytes',
              },
            });
          }
        }
        const body = Buffer.from(data).buffer.slice(0, totalSize) as ArrayBuffer;
        return new Response(body, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(totalSize),
            'Accept-Ranges': 'bytes',
          },
        });
      }
    }

    // ── 流式输出 + 后台缓存 ──
    const estimatedSize = sizeStr ? parseInt(sizeStr, 10) : 0;
    return handleStreamExtract(mkvUrl, targetTrack, cacheKey, hash || '', estimatedSize);
  });

  console.log(`[MkvExtractor] Protocol ${MKV_EXTRACT_SCHEME}:// registered`);
}

// ── 音轨数据缓存 ──
const extractCache = new Map<string, Buffer>();
// 正在提取中的 Promise，避免同一 key 并发下载
const pendingExtracts = new Map<string, Promise<Buffer | null>>();

/** 清理所有缓存（切歌时调用） */
export function clearMkvExtractCache(): void {
  extractCache.clear();
}

/**
 * 流式提取音轨并返回 Response，同时在后台缓存完整数据
 */
function handleStreamExtract(
  mkvUrl: string,
  targetTrack: number,
  cacheKey: string,
  hash: string,
  estimatedSize: number,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const cacheChunks: Buffer[] = [];

  // 注册 pending Promise，让并发请求等待而不是重复下载
  let resolvePending!: (data: Buffer | null) => void;
  const pendingPromise = new Promise<Buffer | null>((resolve) => {
    resolvePending = resolve;
  });
  pendingExtracts.set(cacheKey, pendingPromise);

  void (async () => {
    let fullData: Buffer | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const parser = createMkvStreamParser({
          targetTrack,
          onData: (chunk) => {
            const buf = Buffer.from(chunk);
            cacheChunks.push(buf);
            writer.write(new Uint8Array(buf)).catch(() => {});
          },
          onTrackInfo: (tracks) => {
            console.log(
              `[MkvExtractor] Track info:`,
              tracks.map((t) => `#${t.trackNumber} (audio)`).join(', '),
            );
          },
          onEnd: () => resolve(),
          onError: (err) => reject(err),
        });

        const upstreamRequest = net.request(mkvUrl);
        upstreamRequest.on('response', (response) => {
          response.on('data', (chunk: Buffer) => parser.feed(new Uint8Array(chunk)));
          response.on('end', () => parser.end());
          response.on('error', (err) => reject(err));
        });
        upstreamRequest.on('error', (err) => reject(err));
        upstreamRequest.end();
      });

      // 提取完成，写入缓存（清理其他歌曲的缓存）
      fullData = Buffer.concat(cacheChunks);
      const hashPrefix = hash ? hash + '#' : '';
      for (const key of extractCache.keys()) {
        if (hashPrefix && !key.startsWith(hashPrefix)) {
          extractCache.delete(key);
        }
      }
      extractCache.set(cacheKey, fullData);
      console.log(`[MkvExtractor] Cached track ${targetTrack}, size: ${fullData.length}`);
    } catch (err) {
      console.error('[MkvExtractor] Extract error:', err);
    } finally {
      writer.close().catch(() => {});
      resolvePending(fullData);
      pendingExtracts.delete(cacheKey);
    }
  })();

  const headers: Record<string, string> = { 'Content-Type': 'audio/mpeg' };
  if (estimatedSize > 0) {
    headers['Content-Length'] = String(estimatedSize);
  }
  return new Response(readable, { headers });
}
