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

// 空格激活型交互元素：原生控件依赖 keydown→keyup 激活，自定义控件（如 role="button" 列表行）
// 可能在 keydown 里同步消费空格。全局快捷键需要避开它们，避免播放切换与元素激活双触发。
const INTERACTIVE_SELECTOR = [
  'button',
  'a',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
].join(',');

export const isInInteractiveContext = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(INTERACTIVE_SELECTOR));
};

export const isInEditableContext = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest(EDITABLE_SELECTOR));
};

export const isInMediaContext = (target: EventTarget | null): boolean => {
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
