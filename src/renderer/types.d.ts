
declare module '@iconify/vue' {
  import type { DefineComponent } from 'vue';
  import type { IconifyIcon } from '@iconify/types';

  export type IconProps = {
    icon: IconifyIcon | string;
    width?: string | number;
    height?: string | number;
    color?: string;
    inline?: boolean;
    rotate?: number | string;
    flip?: string;
  } & Record<string, unknown>;

  export const Icon: DefineComponent<IconProps>;
}
