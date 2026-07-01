<script lang="ts">
	import { AlertTriangle, CheckCircle, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		open: boolean;
		onClose: () => void;
		onAcknowledge: () => void;
		/** Optional anchor element to position above; falls back to bottom-right. */
		anchorEl?: HTMLElement | null;
	}

	let { open, onClose, onAcknowledge, anchorEl }: Props = $props();

	let position = $state({ top: 0, left: 0, width: 192 });

	$effect(() => {
		if (!open) return;
		if (anchorEl) {
			const rect = anchorEl.getBoundingClientRect();
			const width = rect.width * 1.5;
			position = { top: rect.top - 100, left: rect.left + (rect.width - width) / 2, width };
		} else {
			position = { top: window.innerHeight - 200, left: window.innerWidth - 250, width: 192 };
		}
	});

	function acknowledge(): void {
		onAcknowledge();
		onClose();
	}
</script>

{#if open}
	<div
		class="fixed z-50"
		style={`top: ${position.top}px; left: ${position.left}px; width: ${position.width}px;`}
	>
		<div class="rounded-lg border border-border bg-card p-3 shadow-lg">
			<div class="mb-2 flex items-start justify-between">
				<div class="flex items-center gap-1">
					<AlertTriangle class="size-3 shrink-0 text-warning" />
					<h3 class="text-xs font-semibold">Recording Notice</h3>
				</div>
				<Button variant="ghost" size="icon" class="size-5" onclick={onClose} aria-label="Close">
					<X class="size-3" />
				</Button>
			</div>

			<div class="mb-2">
				<p class="mb-1 text-xs text-muted-foreground">Inform participants about recording.</p>
				<div class="rounded border border-warning/30 bg-warning/10 p-1">
					<p class="text-xs font-medium text-warning">US compliance required</p>
				</div>
			</div>

			<div class="flex gap-1">
				<Button
					variant="outline"
					size="sm"
					class="h-6 flex-1 px-2 py-0.5 text-xs"
					onclick={onClose}
				>
					Later
				</Button>
				<Button
					variant="accent"
					size="sm"
					class="h-6 flex-1 px-2 py-0.5 text-xs"
					onclick={acknowledge}
				>
					<CheckCircle class="mr-1 size-2" /> Done
				</Button>
			</div>
		</div>
	</div>
{/if}
