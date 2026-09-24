/**
 * 输出命令串行化。beginSourceChange 使已排队和进行中的旧命令失效，
 * 调用方必须在每次 await 之后再次核对 generation。
 */
export class CommandGate {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  get current(): number {
    return this.generation;
  }

  bump(): number {
    return ++this.generation;
  }

  run<T>(fn: (generation: number) => Promise<T>): Promise<T | null> {
    const generation = this.generation;
    const task = this.tail.then(async () => {
      if (generation !== this.generation) return null;
      return await fn(generation);
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
