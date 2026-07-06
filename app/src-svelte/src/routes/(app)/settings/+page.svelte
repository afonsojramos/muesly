<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { ArrowLeft } from '@lucide/svelte';

	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { SETTINGS_TABS, SETTINGS_TRASH, resolveSettingsTab } from '$lib/settings-tabs';
	import About from '$lib/components/About.svelte';
	import CalendarSettings from '$lib/components/CalendarSettings.svelte';
	import PreferenceSettings from '$lib/components/PreferenceSettings.svelte';
	import RecordingSettings from '$lib/components/RecordingSettings.svelte';
	import SummaryModelSettings from '$lib/components/SummaryModelSettings.svelte';
	import TranscriptSettings from '$lib/components/TranscriptSettings.svelte';
	import TrashSettings from '$lib/components/TrashSettings.svelte';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';

	const platform = usePlatform();

	// The active section is driven by the URL (?tab=…); the sidebar provides the
	// navigation. Calendar is macOS-only, so fall back to General off it.
	const activeTab = $derived.by(() => {
		const tab = resolveSettingsTab(page.url.searchParams.get('tab'));
		return tab === 'calendar' && !platform.isMac ? 'general' : tab;
	});
	const activeLabel = $derived(
		[...SETTINGS_TABS, SETTINGS_TRASH].find((t) => t.value === activeTab)?.label ?? 'General',
	);

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
	<!-- Slim title bar: icon-only back, small centered title. When the sidebar is
	     collapsed this bar reaches the window's left edge, so pad past the traffic
	     lights and the (fixed) sidebar toggle and sit the back button on the same
	     row. Both this h-9 header and the sidebar toggle center an icon-sm in a
	     top-anchored h-9 row, so they align; padding animates with the collapse. -->
	<div class="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
		<div
			data-tauri-drag-region="deep"
			class={cn(
				'relative flex h-9 items-center pr-3 transition-[padding] duration-300',
				sidebar.isCollapsed ? 'pl-[6.5rem]' : 'pl-3',
			)}
		>
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								onclick={goBack}
								variant="ghost"
								size="icon-sm"
								class="text-muted-foreground hover:text-foreground"
								aria-label="Back"
							>
								<ArrowLeft />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>
						Back
						<span class="tracking-wide opacity-60">⌘[</span>
					</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
			<h1
				class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[13px] font-medium text-muted-foreground"
			>
				Settings
			</h1>
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto max-w-4xl p-8 pt-6">
			<h2 class="mb-6 text-2xl font-semibold">{activeLabel}</h2>
			{#if activeTab === 'general'}
				<PreferenceSettings />
			{:else if activeTab === 'recording'}
				<RecordingSettings />
			{:else if activeTab === 'calendar' && platform.isMac}
				<CalendarSettings />
			{:else if activeTab === 'transcription'}
				<TranscriptSettings
					transcriptModelConfig={config.transcriptModelConfig}
					setTranscriptModelConfig={config.setTranscriptModelConfig}
				/>
			{:else if activeTab === 'summary'}
				<SummaryModelSettings />
			{:else if activeTab === 'trash'}
				<TrashSettings />
			{:else if activeTab === 'about'}
				<About />
			{/if}
		</div>
	</div>
</div>
