<script setup lang="ts">
import type { UserIdentityBadge } from '@/utils/userIdentity';
defineProps<{ badges: UserIdentityBadge[] }>();
</script>

<template>
  <span v-if="badges.length" class="user-identity-badges" aria-label="用户身份">
    <span
      v-for="badge in badges"
      :key="badge.key"
      class="user-identity-badge comment-badge"
      :class="`comment-badge-${badge.kind === 'membership' ? 'vip' : badge.kind === 'identity' ? 'auth' : badge.kind}`"
      >{{ badge.label }}</span
    >
  </span>
</template>

<style scoped>
.user-identity-badges {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.user-identity-badge {
  max-width: 100%;
  min-height: 18px;
  height: auto;
  padding-block: 2px;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
