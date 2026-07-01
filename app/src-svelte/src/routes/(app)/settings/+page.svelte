<script lang="ts">
	import { onMount } from 'svelte';
	import { ArrowLeft } from '@lucide/svelte';

	import * as Tabs from '$lib/components/ui/tabs';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Button } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
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
	const tabs: { value: string; label: string }[] = $derived([
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
	     button on the same row. Both this h-9 header and the sidebar toggle center
	     an icon-sm in a top-anchored h-9 row, so they align; the padding animates
	     with the 300ms collapse so it slides. -->
	<div class="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur-sm">
		<div
			data-tauri-drag-region="deep"
			class={cn(
				'relative flex h-9 items-center pr-3 transition-[padding] duration-300',
				sidebar.isCollapsed ? 'pl-[6.5rem]' : 'pl-3'
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
		<div class="mx-auto max-w-6xl p-8 pt-6">
			<Tabs.Root value={tabs[0]?.value ?? 'general'} class="w-full">
				<Tabs.List variant="line" class="w-full justify-start border-b border-border">
					{#each tabs as tab (tab.value)}
						<Tabs.Trigger value={tab.value}>{tab.label}</Tabs.Trigger>
					{/each}
				</Tabs.List>
				<Tabs.Content value="general" class="mt-4">
					<PreferenceSettings />
				</Tabs.Content>
				<Tabs.Content value="recording" class="mt-4">
					<RecordingSettings />
				</Tabs.Content>
				{#if platform.isMac}
					<Tabs.Content value="calendar" class="mt-4">
						<CalendarSettings />
					</Tabs.Content>
				{/if}
				<Tabs.Content value="transcription" class="mt-4">
					<TranscriptSettings
						transcriptModelConfig={config.transcriptModelConfig}
						setTranscriptModelConfig={config.setTranscriptModelConfig}
					/>
				</Tabs.Content>
				<Tabs.Content value="summary" class="mt-4">
					<SummaryModelSettings />
				</Tabs.Content>
				<Tabs.Content value="trash" class="mt-4">
					<TrashSettings />
				</Tabs.Content>
				<!-- Beta tab disabled; Import & Retranscribe is now a standard feature. -->
				<Tabs.Content value="about" class="mt-4">
					<About />
				</Tabs.Content>
			</Tabs.Root>
		</div>
	</div>
</div>
