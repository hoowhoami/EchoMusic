type PluginCallbackRunner = <T>(
  pluginId: string,
  source: string,
  callback: () => T,
  fallback: T,
) => T;

let globalShortcutRegistrationSeq = 0;

export const createShortcutsApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => () => void,
  runPluginCallback: PluginCallbackRunner,
) => {
  const acceleratorToKeys = (accelerator: string): string[] => {
    const cleaned = accelerator.replace(/\s+/g, '');
    if (!cleaned) return [];
    const parts = cleaned.split('+').filter(Boolean);
    const modifiers: string[] = [];
    const keys: string[] = [];
    let hasCmdOrCtrl = false;

    const normalizeKey = (key: string) => key.toLowerCase();

    for (const part of parts) {
      const lower = part.toLowerCase();
      if (['cmdorctrl', 'commandorcontrol', 'command', 'cmd'].includes(lower)) {
        hasCmdOrCtrl = true;
        continue;
      }
      if (['ctrl', 'control'].includes(lower)) {
        modifiers.push('ctrl');
        continue;
      }
      if (['shift'].includes(lower)) {
        modifiers.push('shift');
        continue;
      }
      if (['alt', 'option'].includes(lower)) {
        modifiers.push('alt');
        continue;
      }
      if (['meta', 'win', 'super'].includes(lower)) {
        modifiers.push('meta');
        continue;
      }
      keys.push(normalizeKey(part));
    }

    const buildCombo = (extra: string[]) => {
      const combo = Array.from(new Set([...modifiers, ...extra, ...keys]));
      return combo.sort().join('+');
    };

    if (hasCmdOrCtrl) {
      return [buildCombo(['meta']), buildCombo(['ctrl'])];
    }
    return [buildCombo([])];
  };

  const buildShortcut = (event: KeyboardEvent): string => {
    const keys = new Set<string>();
    if (event.ctrlKey) keys.add('ctrl');
    if (event.metaKey) keys.add('meta');
    if (event.altKey) keys.add('alt');
    if (event.shiftKey) keys.add('shift');
    const mainKey = event.key?.toLowerCase() || '';
    if (mainKey && !['control', 'shift', 'alt', 'meta'].includes(mainKey)) {
      keys.add(mainKey);
    }
    return Array.from(keys).sort().join('+');
  };

  return {
    register: (accelerator: string, handler: () => void) => {
      const targetKeys = acceleratorToKeys(accelerator);
      if (!targetKeys.length) {
        throw new Error(`Invalid accelerator: ${accelerator}`);
      }

      const keydownHandler = (event: KeyboardEvent) => {
        if (event.repeat) return;
        const pressed = buildShortcut(event);
        if (targetKeys.includes(pressed)) {
          event.preventDefault();
          runPluginCallback(pluginId, `快捷键: ${accelerator}`, () => handler(), undefined);
        }
      };

      window.addEventListener('keydown', keydownHandler);
      return addDisposable(() => {
        window.removeEventListener('keydown', keydownHandler);
      });
    },
    registerGlobal: async (accelerator: string, handler: () => void) => {
      const registrationId = `global-${Date.now()}-${++globalShortcutRegistrationSeq}`;
      const result = await window.electron?.shortcuts?.registerPluginGlobal?.({
        pluginId,
        registrationId,
        accelerator,
      });

      if (!result?.ok) {
        const reason = result?.reason === 'conflict' ? 'conflict' : 'invalid';
        const message =
          result?.message ||
          (reason === 'conflict'
            ? 'Shortcut is already registered or reserved by the system'
            : `Invalid accelerator: ${accelerator}`);
        throw new Error(message);
      }

      const removeTrigger = window.electron.shortcuts.onPluginGlobalTrigger((payload) => {
        if (payload.pluginId !== pluginId || payload.registrationId !== registrationId) return;
        runPluginCallback(pluginId, `全局快捷键: ${accelerator}`, () => handler(), undefined);
      });

      return addDisposable(() => {
        removeTrigger();
        void window.electron?.shortcuts?.unregisterPluginGlobal?.({
          pluginId,
          registrationId,
        });
      });
    },
  };
};
