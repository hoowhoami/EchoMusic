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
        // 流事件必须先于 abort 判断挂载：pre-aborted 时 destroy() 之后 open 仍可能
        // 失败并异步 emit 'error'，没有监听会变成 uncaughtException 打崩主进程。
        stream.on('error', (error) => settle(() => controller.error(error)));
        stream.on('end', () => settle(() => controller.close()));
        stream.once('close', () => {
          signal.removeEventListener('abort', onAbort);
          // 兜底：源流既未 end 也未 error 就被销毁（premature close），
          // 否则消费方会永久挂起。
          settle(() => controller.error(new Error('读取流意外关闭')));
        });
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          // 复制 Buffer 以脱离内存池，语义与 Node 适配器一致。
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize !== null && controller.desiredSize <= 0) stream.pause();
        });
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
