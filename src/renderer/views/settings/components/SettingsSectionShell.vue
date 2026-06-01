<script setup lang="ts">
defineProps<{
  id: string;
  title: string;
}>();
</script>

<template>
  <section :data-section="id" class="settings-section">
    <div class="flex items-center gap-3 mb-4">
      <slot name="icon" />
      <h2 class="text-[15px] font-semibold text-text-main">
        {{ title }}
      </h2>
    </div>
    <div class="settings-card">
      <slot />
    </div>
  </section>
</template>

<style scoped src="../settingsSection.css"></style>
