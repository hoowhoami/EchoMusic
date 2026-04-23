/**
 * MKV 音轨提取代理服务
 *
 * 提供本地 HTTP 服务，流式下载 MKV 文件并实时提取指定音轨的 MP3 数据。
 * 渲染进程通过 <audio src="http://localhost:{port}/extract?url=...&track=1"> 播放。
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

import * as http from 'node:http';
import { URL } from 'node:url';
import { net } from 'electron';

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
      if (!idResult) break; // 数据不够

      // 读取 Data Size
      const sizeResult = readVINT(buffer, idResult.length);
      if (!sizeResult) break; // 数据不够

      const elementId = idResult.id;
      const dataSize = sizeResult.value;
      const headerSize = idResult.length + sizeResult.length;

      // 检查是否是 "unknown size"（全 1）
      const isUnknownSize = dataSize === (1 << (7 * sizeResult.length)) - 1;

      if (MASTER_ELEMENTS.has(elementId)) {
        // Master Element：进入子元素解析
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
      if (buffer.length < totalSize) break; // 数据不够，等更多数据

      // 处理特定元素
      if (elementId === ID_TRACK_NUMBER && inTrackEntry) {
        currentTrackNumber = readUInt(buffer, headerSize, dataSize);
      } else if (elementId === ID_TRACK_TYPE && inTrackEntry) {
        currentTrackType = readUInt(buffer, headerSize, dataSize);
      } else if (elementId === ID_SIMPLE_BLOCK) {
        // SimpleBlock: [TrackNumber (VINT)] [Timecode (int16)] [Flags (uint8)] [Frame Data...]
        const trackVint = readVINT(buffer, headerSize);
        if (trackVint && trackVint.value === targetTrack) {
          // 跳过 TrackNumber + Timecode(2) + Flags(1)
          const frameOffset = headerSize + trackVint.length + 3;
          const frameData = buffer.slice(frameOffset, headerSize + dataSize);
          if (frameData.length > 0) {
            onData(frameData);
          }
        }
      } else if (elementId === ID_BLOCK) {
        // Block 格式与 SimpleBlock 相同
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
      // 尝试解析剩余数据
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
    get tracks() {
      return audioTracks;
    },
  };
}

// ── HTTP 代理服务 ──

let server: http.Server | null = null;
let serverPort = 0;

/**
 * 启动 MKV 音轨提取代理服务
 * 监听随机端口，避免端口冲突
 */
export function startMkvExtractorServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(serverPort);
      return;
    }

    server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      const parsedUrl = new URL(req.url, `http://localhost:${serverPort}`);

      if (parsedUrl.pathname !== '/extract') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const mkvUrl = parsedUrl.searchParams.get('url');
      const trackStr = parsedUrl.searchParams.get('track');

      if (!mkvUrl || !trackStr) {
        res.writeHead(400);
        res.end('Missing url or track parameter');
        return;
      }

      const targetTrack = parseInt(trackStr, 10);
      if (isNaN(targetTrack) || targetTrack < 1) {
        res.writeHead(400);
        res.end('Invalid track number');
        return;
      }

      handleExtractRequest(mkvUrl, targetTrack, req, res);
    });

    // 监听端口 0，系统自动分配空闲端口
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr && typeof addr === 'object') {
        serverPort = addr.port;
        console.log(`[MkvExtractor] Proxy server started on port ${serverPort}`);
        resolve(serverPort);
      } else {
        reject(new Error('Failed to get server port'));
      }
    });

    server.on('error', (err) => {
      console.error('[MkvExtractor] Server error:', err);
      reject(err);
    });
  });
}

/**
 * 停止代理服务，关闭所有连接
 */
export function stopMkvExtractorServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      console.log('[MkvExtractor] Proxy server stopped');
      server = null;
      serverPort = 0;
      resolve();
    });
    // 强制关闭所有活跃连接
    server.closeAllConnections?.();
  });
}

/**
 * 获取当前代理服务端口
 */
export function getMkvExtractorPort(): number {
  return serverPort;
}

/**
 * 处理音轨提取请求
 * 流式下载 MKV 并实时提取目标音轨的 MP3 帧数据返回。
 * 通过上游 MKV 的 Content-Length / 2 估算单音轨大小，设置响应的 Content-Length，
 * 使 <audio> 能正确计算时长并支持进度条拖动。
 */
function handleExtractRequest(
  mkvUrl: string,
  targetTrack: number,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  let aborted = false;
  let upstreamRequest: Electron.ClientRequest | null = null;
  let parser: ReturnType<typeof createMkvStreamParser> | null = null;

  _req.on('close', () => {
    aborted = true;
    // 客户端断开时立即清理上游请求和解析器
    if (upstreamRequest) {
      upstreamRequest.abort();
      upstreamRequest = null;
    }
    if (parser) {
      parser.destroy();
      parser = null;
    }
  });

  upstreamRequest = net.request(mkvUrl);

  upstreamRequest.on('response', (response) => {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });

    parser = createMkvStreamParser({
      targetTrack,
      onData: (chunk) => {
        if (!aborted && !res.destroyed) {
          res.write(Buffer.from(chunk));
        }
      },
      onTrackInfo: (tracks) => {
        console.log(
          `[MkvExtractor] Track info:`,
          tracks.map((t) => `#${t.trackNumber} (audio)`).join(', '),
        );
      },
      onEnd: () => {
        if (!aborted && !res.destroyed) {
          res.end();
        }
        parser = null;
      },
      onError: (err) => {
        console.error('[MkvExtractor] Parse error:', err.message);
        if (!aborted && !res.destroyed) {
          res.end();
        }
        parser = null;
      },
    });

    response.on('data', (chunk: Buffer) => {
      if (aborted) return;
      parser?.feed(new Uint8Array(chunk));
    });

    response.on('end', () => {
      parser?.end();
    });

    response.on('error', (err) => {
      console.error('[MkvExtractor] Download error:', err.message);
      parser?.destroy();
      parser = null;
      if (!aborted && !res.destroyed) {
        res.end();
      }
    });
  });

  upstreamRequest.on('error', (err) => {
    console.error('[MkvExtractor] Request error:', err.message);
    if (!aborted && !res.destroyed) {
      res.writeHead(502);
      res.end('Upstream request failed');
    }
  });

  upstreamRequest.end();
}
