export function createStyleDisposer(pluginId: string, cssText: string, styleId = 'runtime') {
  const elementId = `echo-plugin-style-${pluginId}-${styleId}`;
  document.getElementById(elementId)?.remove();
  const style = document.createElement('style');
  style.id = elementId;
  style.dataset.pluginId = pluginId;
  style.textContent = cssText;
  document.head.appendChild(style);
  return () => style.remove();
}
