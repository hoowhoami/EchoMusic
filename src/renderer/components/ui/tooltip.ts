import {
  getCurrentInstance,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  watch,
  type ComponentInternalInstance,
  type AppContext,
  type ObjectDirective,
  type Ref,
} from 'vue';
import { bindTooltip, type TooltipValue } from './tooltipRuntime';

type Binding = ReturnType<typeof bindTooltip>;
const owners = new WeakMap<ComponentInternalInstance, Set<Binding>>();
const contexts = new WeakMap<ComponentInternalInstance, AppContext>();
function contextFor(owner: ComponentInternalInstance | null | undefined) {
  if (!owner) return;
  let context = contexts.get(owner);
  if (!context) {
    // Programmatically rendered rich slots must inherit the caller's local provides,
    // as they did when the surface lived in its component subtree.
    const { provides } = owner as ComponentInternalInstance & { provides: AppContext['provides'] };
    context = { ...owner.appContext, provides };
    contexts.set(owner, context);
  }
  return context;
}
function track(owner: ComponentInternalInstance | null | undefined, binding: Binding) {
  if (!owner) return () => {};
  let bindings = owners.get(owner);
  if (!bindings) {
    bindings = new Set();
    owners.set(owner, bindings);
    const group = bindings;
    onDeactivated(() => group.forEach((item) => item.suspend(true)), owner);
    onActivated(() => group.forEach((item) => item.suspend(false)), owner);
  }
  bindings.add(binding);
  return () => bindings!.delete(binding);
}
const elements = new WeakMap<HTMLElement, { binding: Binding; untrack: () => void }>();
/**
 * Tooltip, Button and the native-element directive share the same automatic policy:
 * complete repeated text stays quiet; clipped text, icon labels and explanations show.
 * Mark the clipped child with data-tooltip-label when the trigger contains other content.
 * Accessible names remain independent of tooltip visibility.
 */
export const vTooltip: ObjectDirective<HTMLElement, TooltipValue> = {
  mounted(element, { value, instance }) {
    const owner = instance?.$;
    const binding = bindTooltip(element, value, contextFor(owner));
    elements.set(element, { binding, untrack: track(owner, binding) });
  },
  updated(element, { value }) {
    elements.get(element)?.binding.update(value);
  },
  beforeUnmount(element) {
    const record = elements.get(element);
    record?.binding.dispose();
    record?.untrack();
    elements.delete(element);
  },
};

// Component APIs bind to their forwarded native element; directives stay on native tags.
export function useElementTooltip(
  element: Ref<HTMLElement | undefined>,
  value: () => TooltipValue,
) {
  const owner = getCurrentInstance();
  let binding: Binding | undefined;
  let untrack = () => {};
  const dispose = () => {
    binding?.dispose();
    binding = undefined;
    untrack();
  };
  watch(
    [element, value],
    ([node, options], [previous]) => {
      const content = typeof options === 'string' ? options : options ? options.content : undefined;
      if (
        (!content?.trim() && !(options && typeof options === 'object' && options.renderContent)) ||
        (options && typeof options === 'object' && options.disabled)
      ) {
        dispose();
        return;
      }
      if (node !== previous || !binding) {
        dispose();
        if (node) {
          binding = bindTooltip(node, options, contextFor(owner));
          untrack = track(owner, binding);
        }
      } else binding.update(options);
    },
    { immediate: true, flush: 'post' },
  );
  onBeforeUnmount(dispose);
}
