<script setup lang="ts">
import { TooltipProvider, injectTooltipProviderContext } from 'reka-ui';

// Standalone plugin mounts can also use the shared controls.
const parent = injectTooltipProviderContext(null);
</script>

<template>
  <slot v-if="parent" />
  <TooltipProvider
    v-else
    :delay-duration="350"
    :skip-delay-duration="300"
    ignore-non-keyboard-focus
  >
    <slot />
  </TooltipProvider>
</template>
