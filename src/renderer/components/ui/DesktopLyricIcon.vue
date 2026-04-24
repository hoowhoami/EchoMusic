<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 48 48">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="3"
      d="M29.42 26.431h4.743m-4.742-3.868h8.127m-8.127-3.869h8.127m-21.07 10.002a3.036 3.036 0 1 0-6.07-.11a3.036 3.036 0 0 0 6.07.11v-8.44h3.56M28.235 5.64H39.6a2.895 2.895 0 0 1 2.9 2.89v27.542a2.895 2.895 0 0 1-2.888 2.902H23.164m5.07-33.333l-8.377 33.332l2.514 3.385"
    />
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="3"
      d="M27.364 9.026H8.4a2.895 2.895 0 0 0-2.9 2.89v27.541a2.895 2.895 0 0 0 2.888 2.902h13.983l.794-3.385h-3.309"
    />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>
