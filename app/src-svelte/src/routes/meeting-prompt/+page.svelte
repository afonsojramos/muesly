<script lang="ts">
	import { onMount } from 'svelte';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { Mic, X } from '@lucide/svelte';

	import IconButton from '$lib/components/IconButton.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import { Button } from '$lib/components/ui/button';

	interface PromptPayload {
		title: string | null;
		source: 'calendar' | 'app';
		app_name: string | null;
	}

	let prompt = $state<PromptPayload | null>(null);
	let starting = $state(false);
	let error = $state<string | null>(null);

	const heading = $derived(
		prompt?.source === 'app'
			? `${prompt.app_name ?? 'A meeting app'} is open`
			: (prompt?.title ?? 'Meeting started'),
	);
	const subtitle = $derived(
		prompt?.source === 'app'
			? 'Record and transcribe this meeting?'
			: 'This meeting just started. Record it?',
	);

	onMount(() => {
		// The OS window is transparent; keep the document transparent too so the
		// rounded card is the only visible chrome (same pattern as the pill).
		document.documentElement.classList.add('meeting-prompt-route');

		const unlisteners: UnlistenFn[] = [];
		void listen<PromptPayload>('meeting-prompt-updated', (event) => {
			prompt = event.payload;
			starting = false;
			error = null;
		}).then((fn) => unlisteners.push(fn));
		void listen<{ message: string }>('meeting-prompt-error', (event) => {
			starting = false;
			error = event.payload.message || 'Could not start recording.';
		}).then((fn) => unlisteners.push(fn));

		return () => {
			document.documentElement.classList.remove('meeting-prompt-route');
			for (const fn of unlisteners) fn();
		};
	});

	function start(): void {
		if (starting) return;
		starting = true;
		error = null;
		void emit('meeting-prompt-accept-clicked');
	}

	function dismiss(): void {
		void emit('meeting-prompt-dismiss-clicked');
	}
</script>

<div class="flex h-screen w-screen items-start justify-end p-2">
	<div
		class="flex w-full flex-col gap-2.5 rounded-2xl border border-border bg-card p-3.5 shadow-lg"
	>
		<div class="flex items-start gap-2.5">
			<span class="relative mt-1 flex size-2.5 shrink-0">
				<span class="absolute inline-flex h-full w-full rounded-full bg-destructive opacity-60"
				></span>
				<span class="relative inline-flex size-2.5 rounded-full bg-destructive"></span>
			</span>
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-semibold text-foreground">{heading}</p>
				<p class="truncate text-xs text-muted-foreground">
					{#if error}
						<span class="text-destructive">{error}</span>
					{:else}
						{subtitle}
					{/if}
				</p>
			</div>
			<IconButton label="Dismiss" size="icon-xs" class="text-muted-foreground" onclick={dismiss}>
				<X />
			</IconButton>
		</div>
		<div class="flex justify-end gap-2">
			<Button size="sm" disabled={starting} onclick={start}>
				{#if starting}
					<Spinner class="size-3.5" />
					Starting…
				{:else}
					<Mic data-icon />
					{error ? 'Try again' : 'Start recording'}
				{/if}
			</Button>
		</div>
	</div>
</div>

<style>
	:global(html.meeting-prompt-route),
	:global(html.meeting-prompt-route body) {
		background: transparent !important;
	}
</style>
