<script lang="ts">
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';

	import type { GlobalShortcutInfo } from '$lib/bindings';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import { formatAccelerator, keyEventToAccelerator } from '$lib/shortcut-accel';
	import { cn } from '$lib/utils';

	interface Props {
		info: GlobalShortcutInfo;
		/** Persist a new accelerator; null resets to the default. */
		onChange: (accelerator: string | null) => Promise<void>;
	}

	let { info, onChange }: Props = $props();

	const platform = usePlatform();
	let capturing = $state(false);
	let saving = $state(false);

	async function commit(accelerator: string | null): Promise<void> {
		saving = true;
		try {
			await onChange(accelerator);
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (!capturing) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.code === 'Escape') {
			capturing = false;
			return;
		}
		const accelerator = keyEventToAccelerator(e, platform.isMac);
		// Modifier-only or unmapped keys: keep listening for a full chord.
		if (!accelerator) return;
		capturing = false;
		void commit(accelerator);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex items-center gap-1">
	{#if info.is_custom}
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-sm"
							class="text-muted-foreground hover:text-foreground"
							disabled={saving || capturing}
							onclick={() => void commit(null)}
							aria-label="Reset to default shortcut"
						>
							<RotateCcwIcon />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>
					Reset to {formatAccelerator(info.default_accelerator, platform.isMac)}
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	{/if}
	<Button
		variant="outline"
		size="sm"
		class={cn('min-w-28 font-mono tabular-nums', capturing && 'ring-2 ring-ring')}
		disabled={saving}
		onclick={() => (capturing = !capturing)}
		onblur={() => (capturing = false)}
		aria-label={capturing ? 'Press the new shortcut, Escape to cancel' : 'Change shortcut'}
	>
		{capturing ? 'Press shortcut…' : formatAccelerator(info.accelerator, platform.isMac)}
	</Button>
</div>
