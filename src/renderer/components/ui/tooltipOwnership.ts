// Portalled hints belong only to the control that opened them, not every open panel.
const owners = new WeakMap<Node, HTMLElement>();

export function setTooltipOwner(surface: Node, trigger: HTMLElement) {
  owners.set(surface, trigger);
  return () => owners.delete(surface);
}

export function isOwnedTooltipTarget(target: Node, contains: (node: Node) => boolean): boolean {
  let node: Node | null = target;
  while (node) {
    const owner = owners.get(node);
    if (owner) return contains(owner);
    node = node.parentNode;
  }
  return false;
}
