// 通过解析 WAV（RIFF/WAVE）文件头计算音频时长。
// 数据由调用方提供（如远端 Range 请求返回的头部片段），本模块不做任何 IO。

const chunkId = (buffer: Buffer, offset: number): string =>
  buffer.subarray(offset, offset + 4).toString('ascii');

/**
 * 从 WAV 头部片段解析时长（秒）。
 * 依赖 `fmt ` chunk 的 byteRate（每秒字节数）与 `data` chunk 的 dataSize。
 * 片段需覆盖到 `data` chunk 头；WAV 头极小（通常前 64 字节内），拉取前几 KB 即可。
 */
export const parseWavHeaderDuration = (head: Buffer): number | null => {
  if (head.length < 12) return null;
  if (chunkId(head, 0) !== 'RIFF' || chunkId(head, 8) !== 'WAVE') return null;

  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= head.length) {
    const id = chunkId(head, offset);
    const size = head.readUInt32LE(offset + 4);
    if (id === 'data') {
      // 缺 fmt byteRate，或 data 声明为空（流式写入未回填大小时长未知）。
      if (!byteRate || size <= 0) return null;
      return size / byteRate;
    }
    if (id === 'fmt ' && offset + 8 + 16 <= head.length) {
      // fmt 数据布局：audioFormat(2) channels(2) sampleRate(4) byteRate(4)。
      byteRate = head.readUInt32LE(offset + 8 + 8);
    }
    if (size === 0) return null; // 异常头，避免死循环。
    // chunk 按字对齐，奇数长度补 1 字节填充。
    offset += 8 + size + (size % 2);
  }
  return null;
};
