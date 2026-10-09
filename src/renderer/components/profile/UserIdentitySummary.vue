<script setup lang="ts">
import UserIdentityBadges from './UserIdentityBadges.vue';
import Tag from '@/components/ui/Tag.vue';
import type { AccountDisplay } from '@/utils/userIdentity';
defineProps<{ identity: Pick<AccountDisplay, 'badges' | 'tags'> }>();
</script>

<template>
  <div v-if="identity.badges.length || identity.tags.length" class="user-identity-summary">
    <UserIdentityBadges :badges="identity.badges" />
    <span v-if="identity.tags.length" class="user-interest-line" aria-label="用户标签">
      <Tag v-for="tag in identity.tags" :key="tag" tone="muted">{{ tag }}</Tag>
    </span>
  </div>
</template>

<style scoped>
.user-identity-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.user-interest-line {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.user-interest-line :deep(.ui-tag) {
  max-width: 100%;
  min-height: 18px;
  height: auto;
  padding-block: 2px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
