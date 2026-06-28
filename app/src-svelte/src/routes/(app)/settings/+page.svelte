<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft } from '@lucide/svelte';

	import Tooltip from '$lib/ui/tooltip.svelte';
	import { cn } from '$lib/utils';

	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import Tabs, { type TabItem } from '$lib/ui/tabs.svelte';
	import About from '$lib/components/About.svelte';
	// Beta section disabled: Import Audio & Retranscribe graduated to a standard feature.
	// import BetaSettings from '$lib/components/BetaSettings.svelte';
	import CalendarSettings from '$lib/components/CalendarSettings.svelte';
	import PreferenceSettings from '$lib/components/PreferenceSettings.svelte';
	import RecordingSettings from '$lib/components/RecordingSettings.svelte';
	import SummaryModelSettings from '$lib/components/SummaryModelSettings.svelte';
	import TranscriptSettings from '$lib/components/TranscriptSettings.svelte';
	import TrashSettings from '$lib/components/TrashSettings.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';

	const platform = usePlatform();

	// Calendar context relies on macOS EventKit, so the tab is macOS-only.
	const tabs: TabItem[] = $derived([
		{ value: 'general', label: 'General' },
		{ value: 'recording', label: 'Recordings' },
		...(platform.isMac ? [{ value: 'calendar', label: 'Calendar' }] : []),
		{ value: 'transcription', label: 'Transcription' },
		{ value: 'summary', label: 'Summary' },
		{ value: 'trash', label: 'Trash' },
		// { value: 'beta', label: 'Beta' },
		{ value: 'about', label: 'About' }
	]);

	function goBack(): void {
		history.back();
	}

	// Standard macOS "back" shortcut, matching the tooltip hint.
	onMount(() => {
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '[') {
				e.preventDefault();
				goBack();
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

<div class="flex h-screen flex-col bg-background">
	<!-- Slim Granola-style title bar: icon-only back, small centered title.
	     When the sidebar is collapsed this bar reaches the window's left edge, so
	     pad past the traffic lights and the (fixed) sidebar toggle and sit the back
	     button on the same row. h-9 keeps it vertically aligned with that toggle
	     (top-[5px]); the padding animates with the 300ms collapse so it slides. -->
	<div class="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
		<div
			data-tauri-drag-region="deep"
			class={cn(
				'relative flex h-9 items-center pr-3 transition-[padding] duration-300',
				sidebar.isCollapsed ? 'pl-[6.5rem]' : 'pl-3'
			)}
		>
			<Tooltip label="Back" shortcut="⌘[">
				{#snippet trigger()}
					<button
						onclick={goBack}
						class="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
						aria-label="Back"
					>
						<ArrowLeft class="size-4" />
					</button>
				{/snippet}
			</Tooltip>
			<h1
				class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[13px] font-medium text-muted-foreground"
			>
				Settings
			</h1>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto max-w-6xl p-8 pt-6">
			<Tabs {tabs}>
				{#snippet panel(value)}
					{#if value === 'general'}
						<PreferenceSettings />
					{:else if value === 'recording'}
						<RecordingSettings />
					{:else if value === 'calendar'}
						<CalendarSettings />
					{:else if value === 'transcription'}
						<TranscriptSettings
							transcriptModelConfig={config.transcriptModelConfig}
							setTranscriptModelConfig={config.setTranscriptModelConfig}
						/>
					{:else if value === 'summary'}
						<SummaryModelSettings />
					{:else if value === 'trash'}
						<TrashSettings />
						<!-- Beta tab disabled; Import & Retranscribe is now a standard feature. -->
					{:else if value === 'about'}
						<About />
					{/if}
				{/snippet}
			</Tabs>
		</div>
	</div>
</div>
