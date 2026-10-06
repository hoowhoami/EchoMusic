/** Let the opening frame paint before running synchronous, expensive DOM work. */
export function afterPaint(callback: () => void) {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      frame = 0;
      timer = window.setTimeout(() => {
        timer = 0;
        callback();
      }, 0);
    });
  });
  let timer = 0;
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
