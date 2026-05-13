import { inject, provide, ref, type InjectionKey, type Ref } from 'vue';

/**
 * 页面滚动容器的 injection key
 * 每个页面通过 PageScrollContainer 提供自己的滚动容器 DOM 引用
 */
export const PAGE_SCROLL_CONTAINER_KEY: InjectionKey<Ref<HTMLElement | null>> =
  Symbol('page-scroll-container');

/**
 * 在页面滚动容器组件中调用，向子组件提供滚动容器引用
 */
export function provideScrollContainer(container: Ref<HTMLElement | null>) {
  provide(PAGE_SCROLL_CONTAINER_KEY, container);
}

/**
 * 在子组件中调用，获取最近的页面滚动容器引用
 */
export function useScrollContainer(): Ref<HTMLElement | null> {
  return inject(PAGE_SCROLL_CONTAINER_KEY, ref(null));
}
