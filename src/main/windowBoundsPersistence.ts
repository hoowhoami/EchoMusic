export type WindowBoundsChangeKind = 'move' | 'resize';

type WindowBoundsEventTarget = {
  on(event: string, listener: () => void): unknown;
};

/**
 * Windows can emit moved/resized after programmatic window creation, presentation,
 * or DPI reconciliation. Only a preceding will-move/will-resize proves that the
 * native event came from a user interaction.
 */
export class WindowBoundsPersistenceGate {
  private readonly requireManualChange: boolean;
  private readonly pendingManualChange: Record<WindowBoundsChangeKind, boolean> = {
    move: false,
    resize: false,
  };

  constructor(platform: NodeJS.Platform = process.platform) {
    this.requireManualChange = platform === 'win32';
  }

  markManualChange(kind: WindowBoundsChangeKind) {
    this.pendingManualChange[kind] = true;
  }

  shouldPersist(kind: WindowBoundsChangeKind): boolean {
    if (!this.requireManualChange) return true;
    if (!this.pendingManualChange[kind]) return false;
    this.pendingManualChange[kind] = false;
    return true;
  }
}

export const bindWindowBoundsPersistenceEvents = (
  target: WindowBoundsEventTarget,
  persist: () => void,
  platform: NodeJS.Platform = process.platform,
) => {
  const gate = new WindowBoundsPersistenceGate(platform);
  if (platform === 'win32') {
    target.on('will-move', () => gate.markManualChange('move'));
    target.on('will-resize', () => gate.markManualChange('resize'));
    target.on('moved', () => {
      if (gate.shouldPersist('move')) persist();
    });
    target.on('resized', () => {
      if (gate.shouldPersist('resize')) persist();
    });
    return;
  }
  target.on('move', persist);
  target.on('resize', persist);
};

export const shouldFlushWindowBounds = (
  boundsDirty: boolean,
  platform: NodeJS.Platform = process.platform,
) => platform !== 'win32' || boundsDirty;
