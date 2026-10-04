<script lang="ts">
import { defineComponent, onDeactivated } from 'vue';
import { injectTooltipRootContext } from 'reka-ui';

// Keep the trigger mounted while cancelling Reka's pending hover timer.
export default defineComponent({
  name: 'TooltipLifecycle',
  setup() {
    const context = injectTooltipRootContext();
    onDeactivated(() => context.onClose());
    return () => null;
  },
});
</script>
