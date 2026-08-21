import { randomBytes } from 'node:crypto';
import { screen, type BrowserWindow, type Rectangle, type WebContents } from 'electron';

export type WindowDragBounds = Rectangle;
export type WindowDragKind = 'drag' | 'resize';

type WindowDragSession = {
  id: string;
  kind: WindowDragKind;
  senderId: number;
  origin: Rectangle;
  cursorX: number | null;
  cursorY: number | null;
};

export type WindowDragControllerOptions = {
  getWindow: () => BrowserWindow | null;
  getTargetWebContents?: () => WebContents | null;
  canStart?: (kind: WindowDragKind) => boolean;
  isAvailable?: (kind: WindowDragKind) => boolean;
  transformBounds?: (bounds: Rectangle, kind: WindowDragKind) => Rectangle;
  persist?: () => void;
  rollback?: (origin: Rectangle) => void;
};

const SESSION_PATTERN = /^(.*):([0-9a-f]{32}):([1-9][0-9]{0,9})$/i;
const TOMBSTONE_TTL_MS = 60_000;
const TOMBSTONE_LIMIT = 100;
const GENERATION_TTL_MS = 60_000;
const GENERATION_LIMIT = 100;

export class WindowDragController {
  private session: WindowDragSession | null = null;
  private tombstones = new Map<string, number>();
  private generations = new Map<string, { nonce: string; generation: number; updatedAt: number }>();
  private readonly options: WindowDragControllerOptions;

  constructor(options: WindowDragControllerOptions);
  constructor(
    getWindow: () => BrowserWindow | null,
    transformBounds?: (bounds: Rectangle) => Rectangle,
    persist?: () => void,
  );
  constructor(
    optionsOrGetWindow: WindowDragControllerOptions | (() => BrowserWindow | null),
    transformBounds?: (bounds: Rectangle) => Rectangle,
    persist?: () => void,
  ) {
    this.options =
      typeof optionsOrGetWindow === 'function'
        ? { getWindow: optionsOrGetWindow, transformBounds, persist }
        : optionsOrGetWindow;
  }

  getSessionNonce(sender: WebContents | number): string | null {
    if (!this.isSender(sender)) return null;
    return randomBytes(16).toString('hex');
  }

  start(sessionId: string, sender: WebContents | number, kind: WindowDragKind = 'drag'): boolean {
    this.pruneTombstones();
    this.pruneGenerations();
    if (
      !this.isValidSession(sessionId) ||
      !this.isSender(sender) ||
      this.session ||
      !this.isAvailable(kind) ||
      this.options.canStart?.(kind) === false ||
      this.tombstones.delete(this.key(sender, kind, sessionId))
    )
      return false;

    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return false;
    let origin: Rectangle;
    try {
      origin = win.getBounds();
    } catch {
      return false;
    }
    const token = this.getSessionToken(sessionId);
    const generationKey = this.generationKey(sender, kind);
    const previous = this.generations.get(generationKey);
    if (previous?.nonce === token.nonce && token.generation <= previous.generation) return false;
    this.generations.set(generationKey, { ...token, updatedAt: Date.now() });
    let cursorX: number | null = null;
    let cursorY: number | null = null;
    if (kind === 'drag') {
      try {
        const cursor = screen.getCursorScreenPoint();
        if (Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
          cursorX = cursor.x;
          cursorY = cursor.y;
        }
      } catch {
        // Renderer coordinates remain the fallback when native lookup fails.
      }
    }
    this.session = {
      id: sessionId,
      kind,
      senderId: this.senderId(sender),
      origin,
      cursorX,
      cursorY,
    };
    return true;
  }

  move(
    sessionId: string,
    sender: WebContents | number,
    x: number,
    y: number,
    kind: WindowDragKind = 'drag',
  ): WindowDragBounds | null {
    const session = this.authorize(sessionId, sender, kind);
    const win = this.options.getWindow();
    if (!session || !win || win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y))
      return null;
    let next = {
      x: Math.round(x),
      y: Math.round(y),
      width: session.origin.width,
      height: session.origin.height,
    };
    if (kind === 'drag') {
      try {
        const cursor = screen.getCursorScreenPoint();
        if (
          session.cursorX !== null &&
          session.cursorY !== null &&
          Number.isFinite(cursor.x) &&
          Number.isFinite(cursor.y)
        ) {
          next = {
            ...next,
            x: Math.round(session.origin.x + cursor.x - session.cursorX),
            y: Math.round(session.origin.y + cursor.y - session.cursorY),
          };
        }
      } catch {
        // Keep renderer fallback coordinates.
      }
    }
    return this.setBounds(win, next, kind);
  }

  resize(
    sessionId: string,
    sender: WebContents | number,
    bounds: Rectangle,
  ): WindowDragBounds | null {
    if (!bounds || !Object.values(bounds).every(Number.isFinite)) return null;
    return this.setBoundsIfAuthorized(sessionId, sender, bounds, 'resize');
  }

  end(sessionId: string, sender: WebContents | number, kind: WindowDragKind = 'drag') {
    const session = this.authorizeSession(sessionId, sender, kind);
    if (!session) return null;
    this.clear();
    return this.getBounds();
  }

  cancel(
    sessionId?: string,
    sender?: WebContents | number,
    kind: WindowDragKind = 'drag',
  ): WindowDragBounds | null {
    if (!sessionId || sender === undefined) {
      const active = this.session;
      if (!active) return null;
      return this.cancel(active.id, active.senderId, active.kind);
    }
    const session = this.authorizeSession(sessionId, sender, kind);
    if (!session) {
      if (this.isSender(sender) && this.isValidSession(sessionId))
        this.addTombstone(sender, kind, sessionId);
      return null;
    }
    const win = this.options.getWindow();
    this.clear();
    if (win && !win.isDestroyed()) {
      try {
        this.options.rollback?.(session.origin);
        if (!this.options.rollback) win.setBounds(session.origin, false);
        this.options.persist?.();
      } catch {
        // Ignore a window destroyed during cancellation.
      }
    }
    return this.getBounds();
  }

  cancelAll() {
    const active = this.session;
    if (!active) return { kind: null as WindowDragKind | null, bounds: null };
    return { kind: active.kind, bounds: this.cancel(active.id, active.senderId, active.kind) };
  }

  clear() {
    this.session = null;
  }

  dispose() {
    this.session = null;
    this.tombstones.clear();
    this.generations.clear();
  }

  clearSession(
    sessionId: string,
    sender: WebContents | number,
    kind: WindowDragKind = 'drag',
  ): boolean {
    if (!this.authorizeSession(sessionId, sender, kind)) return false;
    this.clear();
    return true;
  }

  private setBoundsIfAuthorized(
    sessionId: string,
    sender: WebContents | number,
    bounds: Rectangle,
    kind: WindowDragKind,
  ) {
    const session = this.authorize(sessionId, sender, kind);
    const win = this.options.getWindow();
    return session && win && !win.isDestroyed() ? this.setBounds(win, bounds, kind) : null;
  }

  private setBounds(win: BrowserWindow, bounds: Rectangle, kind: WindowDragKind) {
    try {
      win.setBounds(this.options.transformBounds?.(bounds, kind) ?? bounds, false);
      this.options.persist?.();
      return win.getBounds();
    } catch {
      return null;
    }
  }

  private authorize(sessionId: string, sender: WebContents | number, kind: WindowDragKind) {
    const session = this.authorizeSession(sessionId, sender, kind);
    return session && this.isAvailable(kind) && this.options.canStart?.(kind) !== false
      ? session
      : null;
  }

  private authorizeSession(sessionId: string, sender: WebContents | number, kind: WindowDragKind) {
    const session = this.session;
    return session &&
      session.id === sessionId &&
      session.kind === kind &&
      session.senderId === this.senderId(sender) &&
      this.isSender(sender)
      ? session
      : null;
  }

  private isSender(sender: WebContents | number) {
    const target = this.options.getTargetWebContents?.();
    return target ? (typeof sender === 'number' ? target.id === sender : target === sender) : true;
  }

  private senderId(sender: WebContents | number) {
    return typeof sender === 'number' ? sender : sender.id;
  }

  private isAvailable(kind: WindowDragKind) {
    return this.options.isAvailable?.(kind) !== false;
  }

  private isValidSession(id: string) {
    return typeof id === 'string' && id.length <= 160 && SESSION_PATTERN.test(id);
  }

  private getSessionToken(id: string) {
    const match = SESSION_PATTERN.exec(id);
    return { nonce: match?.[2] ?? '', generation: Number(match?.[3] ?? 0) };
  }

  private generationKey(sender: WebContents | number, kind: WindowDragKind) {
    return `${this.senderId(sender)}:${kind}`;
  }

  private key(sender: WebContents | number, kind: WindowDragKind, id: string) {
    return `${this.generationKey(sender, kind)}:${id}`;
  }

  private addTombstone(sender: WebContents | number, kind: WindowDragKind, id: string) {
    this.tombstones.set(this.key(sender, kind, id), Date.now());
    this.pruneTombstones();
  }

  private pruneTombstones() {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const [key, timestamp] of this.tombstones) {
      if (timestamp >= cutoff) break;
      this.tombstones.delete(key);
    }
    while (this.tombstones.size > TOMBSTONE_LIMIT) {
      const first = this.tombstones.keys().next().value;
      if (first === undefined) break;
      this.tombstones.delete(first);
    }
  }

  private pruneGenerations() {
    // Keep recent generations briefly to reject replayed renderer sessions without
    // retaining state indefinitely after a renderer reload.
    const cutoff = Date.now() - GENERATION_TTL_MS;
    for (const [key, generation] of this.generations) {
      if (generation.updatedAt < cutoff) this.generations.delete(key);
    }
    while (this.generations.size > GENERATION_LIMIT) {
      const first = this.generations.keys().next().value;
      if (first === undefined) break;
      this.generations.delete(first);
    }
  }

  private getBounds() {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      return win.getBounds();
    } catch {
      return null;
    }
  }
}
