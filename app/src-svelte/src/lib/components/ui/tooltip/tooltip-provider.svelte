<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';

	const APP_TOOLTIP_DELAY_MS = 500;
	let { ...restProps }: TooltipPrimitive.ProviderProps = $props();
</script>

<!-- Tooltip timing is intentionally app-global. Keep the explicit value after
     spread so nested providers cannot silently introduce inconsistent delays. -->
<TooltipPrimitive.Provider {...restProps} delayDuration={APP_TOOLTIP_DELAY_MS} />
