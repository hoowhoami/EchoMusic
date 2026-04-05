<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { iconTriangleAlert } from '@/icons';
import Button from '@/components/ui/Button.vue';

const route = useRoute();
const router = useRouter();

const errorMessage = computed(() => (route.query.message as string) || '发生了一些未知的错误');
const errorStatus = computed(() => (route.query.status as string) || 'App Error');
const errorSource = computed(() => (route.query.from as string) || '当前页面');

const handleGoHome = () => {
  router.replace('/main/home');
};
</script>

<template>
  <div class="error-page">
    <div class="error-ambient error-ambient--primary"></div>
    <div class="error-ambient error-ambient--danger"></div>

    <section class="error-shell">
      <div class="error-badge">
        <span class="error-badge-dot"></span>
        页面异常
      </div>

      <div class="error-hero">
        <div class="error-icon-wrap">
          <div class="error-icon-ring"></div>
          <div class="error-icon-core">
            <Icon :icon="iconTriangleAlert" width="34" height="34" class="error-icon" />
          </div>
        </div>

        <div class="error-copy">
          <h1 class="error-title">这个页面暂时打不开</h1>
          <p class="error-description">
            {{ errorMessage }}
          </p>
        </div>
      </div>

      <div class="error-meta-grid">
        <div class="error-meta-card">
          <div class="error-meta-label">状态</div>
          <div class="error-meta-value error-meta-value--status">{{ errorStatus }}</div>
        </div>
        <div class="error-meta-card">
          <div class="error-meta-label">来源</div>
          <div class="error-meta-value error-meta-value--path">{{ errorSource }}</div>
        </div>
      </div>

      <div class="error-actions">
        <Button variant="primary" size="sm" class="error-home-btn" @click="handleGoHome">
          回到首页
        </Button>
      </div>
    </section>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.error-page {
  position: relative;
  min-height: calc(100vh - 140px);
  padding: 40px 24px 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  animation: error-fade-in 0.38s ease-out;
}

.error-shell {
  position: relative;
  width: min(720px, 100%);
  padding: 28px;
  border-radius: 30px;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 82%, transparent);
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, white 78%, transparent),
      color-mix(in srgb, white 92%, transparent)
    ),
    var(--color-bg-card);
  box-shadow:
    0 24px 60px rgba(15, 23, 42, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(18px);
}

.dark .error-shell {
  background:
    linear-gradient(
      180deg,
      color-mix(in srgb, #1b1f26 94%, transparent),
      color-mix(in srgb, #101318 98%, transparent)
    ),
    var(--color-bg-card);
  box-shadow:
    0 26px 72px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.error-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: color-mix(in srgb, #ef4444 10%, transparent);
  color: #d23d3d;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.dark .error-badge {
  color: #ff8a8a;
  background: color-mix(in srgb, #ef4444 18%, transparent);
}

.error-badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.88;
}

.error-hero {
  display: flex;
  align-items: center;
  gap: 22px;
  margin-top: 18px;
}

.error-icon-wrap {
  position: relative;
  width: 96px;
  height: 96px;
  flex: 0 0 auto;
}

.error-icon-ring {
  position: absolute;
  inset: 0;
  border-radius: 28px;
  background: radial-gradient(circle at 30% 30%, rgba(239, 68, 68, 0.28), rgba(239, 68, 68, 0.04));
  filter: blur(0.2px);
}

.error-icon-core {
  position: absolute;
  inset: 12px;
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(255, 255, 255, 0.68));
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 12px 28px rgba(239, 68, 68, 0.12);
}

.dark .error-icon-core {
  background: linear-gradient(180deg, rgba(31, 35, 43, 0.94), rgba(20, 22, 28, 0.9));
  border-color: rgba(255, 255, 255, 0.06);
}

.error-icon {
  color: #ef4444;
}

.error-copy {
  min-width: 0;
  flex: 1;
}

.error-title {
  margin: 0;
  font-size: clamp(28px, 4vw, 34px);
  line-height: 1.08;
  font-weight: 800;
  color: var(--color-text-main);
  letter-spacing: -0.03em;
}

.error-description {
  margin: 12px 0 0;
  max-width: 540px;
  font-size: 14px;
  line-height: 1.75;
  color: color-mix(in srgb, var(--color-text-secondary) 92%, transparent);
  word-break: break-word;
}

.error-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 26px;
}

.error-meta-card {
  padding: 16px 18px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
  min-width: 0;
}

.error-meta-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
}

.error-meta-value {
  margin-top: 8px;
  color: var(--color-text-main);
  font-weight: 700;
}

.error-meta-value--status {
  font-size: 14px;
}

.error-meta-value--path {
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
  color: var(--color-text-secondary);
}

.error-actions {
  margin-top: 24px;
}

.error-home-btn {
  min-width: 116px;
  border-radius: 14px;
}

.error-footnote {
  margin: 16px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: color-mix(in srgb, var(--color-text-main) 42%, transparent);
}

.error-ambient {
  position: absolute;
  border-radius: 999px;
  filter: blur(60px);
  pointer-events: none;
  opacity: 0.6;
}

.error-ambient--primary {
  width: 220px;
  height: 220px;
  top: 56px;
  left: max(24px, calc(50% - 420px));
  background: rgba(0, 113, 227, 0.1);
}

.error-ambient--danger {
  width: 180px;
  height: 180px;
  right: max(24px, calc(50% - 360px));
  bottom: 42px;
  background: rgba(239, 68, 68, 0.1);
}

@media (max-width: 720px) {
  .error-page {
    padding: 24px 16px 56px;
    align-items: stretch;
  }

  .error-shell {
    width: 100%;
    padding: 22px;
    border-radius: 24px;
    margin: auto 0;
  }

  .error-hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .error-meta-grid {
    grid-template-columns: 1fr;
  }
}

@keyframes error-fade-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
