const SUPPRESSED_KEY_CODES = new Set([
  'Space',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[role="spinbutton"]',
].join(',');

const MEDIA_SELECTOR = 'video,audio';

export const isInEditableContext = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest(EDITABLE_SELECTOR));
};

const isInMediaContext = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(MEDIA_SELECTOR));
};

type InputBehaviorGuardOptions = {
  isEnabled?: () => boolean;
};

export const installInputBehaviorGuard = (
  options: InputBehaviorGuardOptions = {},
): (() => void) => {
  const handleKeydown = (event: KeyboardEvent) => {
    if (options.isEnabled && !options.isEnabled()) return;
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!SUPPRESSED_KEY_CODES.has(event.code)) return;
    if (isInEditableContext(event.target) || isInMediaContext(event.target)) return;
    event.preventDefault();
  };

  window.addEventListener('keydown', handleKeydown, true);

  return () => {
    window.removeEventListener('keydown', handleKeydown, true);
  };
};
