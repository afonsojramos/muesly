<script lang="ts">
	import { Info, Shield } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		open: boolean;
		onClose: () => void;
		onConfirmDisable: () => void;
	}

	let { open = $bindable(), onClose, onConfirmDisable }: Props = $props();

	const categories = [
		{
			title: '1. Model Preferences',
			items: [
				'Transcription model (e.g. "Whisper large-v3", "Parakeet")',
				'Summary model (e.g. "Llama 3.2", "Claude Sonnet")',
				'Model provider (e.g. "Local", "Ollama", "OpenRouter")'
			],
			note: 'Helps us understand which models users prefer'
		},
		{
			title: '2. Anonymous Meeting Metrics',
			items: [
				'Recording duration',
				'Pause duration',
				'Number of transcript segments',
				'Number of audio chunks processed'
			],
			note: 'Helps us optimize performance and understand usage patterns'
		},
		{
			title: '3. Device Types (Not Names)',
			items: ['Microphone type: Bluetooth / Wired / Unknown', 'System audio type: Bluetooth / Wired / Unknown'],
			note: 'Helps us improve compatibility, NOT the actual device names'
		},
		{
			title: '4. App Usage Patterns',
			items: ['App started/stopped events', 'Session duration', 'Feature usage', 'Error occurrences'],
			note: 'Helps us improve user experience'
		},
		{
			title: '5. Platform Information',
			items: ['Operating system', 'App version', 'Architecture (x86_64 / aarch64)'],
			note: 'Helps us prioritize platform support'
		}
	];

	const notCollected = [
		'Meeting names or titles',
		'Meeting transcripts or content',
		'Audio recordings',
		'Device names (only types: Bluetooth/Wired)',
		'Personal information',
		'Any identifiable data'
	];
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && onClose()}>
	<Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>What We Collect</Dialog.Title>
		</Dialog.Header>

		<div class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
			<div class="rounded-lg border border-success/30 bg-success/10 p-4">
				<div class="flex items-start gap-3">
					<Info class="mt-0.5 size-5 shrink-0 text-success" />
					<div class="text-sm text-success">
						<p class="mb-1 font-semibold">Your Privacy is Protected</p>
						<p>
							We collect <strong>anonymous usage data only</strong>. No meeting content, names, or
							personal information is ever collected.
						</p>
					</div>
				</div>
			</div>

			<div class="flex flex-col gap-4">
				<h3 class="text-lg font-semibold">Data We Collect:</h3>
				{#each categories as cat (cat.title)}
					<div class="rounded-lg border border-border p-4">
						<h4 class="mb-2 font-semibold">{cat.title}</h4>
						<ul class="ml-4 flex flex-col gap-1 text-sm text-muted-foreground">
							{#each cat.items as item (item)}<li>• {item}</li>{/each}
						</ul>
						<p class="mt-2 text-xs italic text-muted-foreground/70">{cat.note}</p>
					</div>
				{/each}
			</div>

			<div class="rounded-lg border border-destructive/20 bg-destructive/5 p-4">
				<h4 class="mb-2 font-semibold text-destructive">What We DON'T Collect:</h4>
				<ul class="ml-4 flex flex-col gap-1 text-sm text-destructive/90">
					{#each notCollected as item (item)}<li>❌ {item}</li>{/each}
				</ul>
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>Keep Analytics Enabled</Button>
			<Button variant="destructive" onclick={onConfirmDisable}>Confirm: Disable Analytics</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Shield class="hidden" />
