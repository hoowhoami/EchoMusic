/** Shared textarea shortcut; keep native newline and IME confirmation behavior. */
export function handleComposerKeydown(event: KeyboardEvent, send: () => void | Promise<void>) {
  if (event.key !== 'Enter') return;
  event.stopPropagation();
  // Some IMEs report keyCode 229 even when isComposing has already become false.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  if (!event.repeat) void send();
}
