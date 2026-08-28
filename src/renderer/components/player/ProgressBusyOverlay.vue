<template>
  <span class="player-progress-busy" aria-hidden="true"></span>
</template>

<style scoped>
.player-progress-busy {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
  /* 忙碌时覆盖普通已播填充，确保动画优先于静态进度色显示。 */
  background: var(--control-track-bg);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.player-progress-busy::before {
  content: '';
  position: absolute;
  inset-block: 0;
  left: -42%;
  width: 46%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    transparent,
    var(--color-primary) 36%,
    color-mix(in srgb, var(--color-primary) 36%, white 64%) 50%,
    var(--color-primary) 64%,
    transparent
  );
  box-shadow: 0 0 5px color-mix(in srgb, var(--color-primary) 72%, transparent);
  animation: player-progress-buffering 1.1s ease-in-out infinite;
}

@keyframes player-progress-buffering {
  to {
    transform: translateX(340%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .player-progress-busy::before {
    left: 0;
    width: 100%;
    animation: player-progress-buffering-reduced 1.2s ease-in-out infinite alternate;
  }

  @keyframes player-progress-buffering-reduced {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 0.85;
    }
  }
}
</style>
