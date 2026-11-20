import type { Readable } from 'node:stream';

/**
 * 把 fs 读取流桥接为 Web ReadableStream。
 *
 * 不复用 Node 的 Readable.toWeb：AbortSignal 触发时，Node 22 的适配器会先让
 * 控制器进入 errored 状态，却仍保留 data 监听；已排队的 chunk 随后派发会对
 * 已结算的控制器 enqueue，抛出未捕获的 ERR_INVALID_STATE，直接打崩主进程
 * （插件复制文件或媒体响应被撤销授权时命中）。这里先用 settled 标志结算控制器、
 * 再销毁源流，迟到事件一律忽略；背压与高水位策略与原适配器一致（按字节计）。
 */
export function fsReadStreamToWeb(
  stream: Readable,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let settled = false;
  const settle = (finish: () => void) => {
    if (settled) return;
    settled = true;
    finish();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const onAbort = () =>
          settle(() => {
            controller.error(signal.reason);
            stream.destroy();
          });
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        stream.once('close', () => signal.removeEventListener('abort', onAbort));
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          // 复制 Buffer 以脱离内存池，语义与 Node 适配器一致。
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) stream.pause();
        });
        stream.on('end', () => settle(() => controller.close()));
        stream.on('error', (error) => settle(() => controller.error(error)));
      },
      pull() {
        if (!settled) stream.resume();
      },
      cancel() {
        settle(() => stream.destroy());
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: stream.readableHighWaterMark }),
  );
}
