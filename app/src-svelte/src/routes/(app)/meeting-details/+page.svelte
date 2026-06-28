<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Loader } from '@lucide/svelte';

	import type { Summary, Transcript } from '$lib/types';
	import { Analytics } from '$lib/analytics';
	import { config } from '$lib/stores/config.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { storageService } from '$lib/services/storage';
	import { usePaginatedTranscripts } from '$lib/hooks/use-paginated-transcripts.svelte';
	import MeetingDetailsView from '$lib/components/MeetingDetails/MeetingDetailsView.svelte';

	interface MeetingDetailsResponse {
		id: string;
		title: string;
		created_at: string;
		updated_at: string;
		transcripts: Transcript[];
		folder_path?: string | null;
	}

	const meetingId = $derived(page.url.searchParams.get('id'));
	const source = $derived(page.url.searchParams.get('source'));

	// Browser dev preview (vite dev without Tauri): sample meeting so the
	// note layout can be exercised visually.
	const isDevPreview =
		import.meta.env.DEV && typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window);
	const devTranscripts: Transcript[] = [
		{ id: 'dt-1', text: "Morning everyone, let's get started with the standup.", timestamp: '09:30:02', audio_start_time: 2, confidence: 0.96, speaker: 'system' },
		{ id: 'dt-2', text: 'Yesterday I finished the audio pipeline refactor and started on the mixer tests.', timestamp: '09:30:18', audio_start_time: 18, confidence: 0.93, speaker: 'mic' },
		{ id: 'dt-3', text: 'The VAD changes are looking good, latency dropped by about thirty percent.', timestamp: '09:30:41', audio_start_time: 41, confidence: 0.91, speaker: 'system' },
		{ id: 'dt-4', text: "I'll pick up the transcript search task next, should land by Thursday.", timestamp: '09:31:05', audio_start_time: 65, confidence: 0.95, speaker: 'mic' }
	];
	const devSummary = {
		markdown:
			'## Key points\n\n- Audio pipeline refactor finished, mixer tests in progress\n- VAD changes reduced latency by ~30%\n\n## Action items\n\n- Land transcript search by Thursday\n- Review mixer test coverage\n'
	} as unknown as Summary;
	const devSegments = devTranscripts.map((t) => ({
		id: t.id,
		timestamp: t.audio_start_time ?? 0,
		endTime: t.audio_end_time,
		text: t.text,
		confidence: t.confidence,
		speaker: t.speaker
	}));

	const paginated = usePaginatedTranscripts(() => (isDevPreview ? null : meetingId));

	let meetingSummary = $state<Summary | null>(null);
	let meetingNotes = $state('');
	let meetingSummaryContext = $state('');
	let error = $state<string | null>(null);
	let isLoadingSummary = $state(true);
	let shouldAutoGenerate = $state(false);
	let hasCheckedAutoGen = $state(false);

	// Build the meeting object from pagination metadata + loaded transcripts.
	const meetingDetails = $derived.by((): MeetingDetailsResponse | null => {
		if (isDevPreview && meetingId) {
			const title =
				sidebar.meetings.find((m) => m.id === meetingId)?.title ?? 'Team standup';
			return {
				id: meetingId,
				title,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				transcripts: devTranscripts,
				folder_path: null
			};
		}
		const metadata = paginated.metadata;
		if (!metadata) return null;
		if (!meetingId || meetingId === 'intro-call') return null;
		return {
			id: metadata.id,
			title: metadata.title,
			created_at: metadata.created_at,
			updated_at: metadata.updated_at,
			transcripts: paginated.transcripts,
			folder_path: metadata.folder_path ?? null
		};
	});

	// Sync the selected meeting into the sidebar store as metadata loads.
	$effect(() => {
		const metadata = paginated.metadata;
		if (metadata && meetingId && meetingId !== 'intro-call') {
			sidebar.setCurrentMeeting({ id: metadata.id, title: metadata.title });
		}
	});

	// Surface transcript loading errors.
	$effect(() => {
		if (paginated.error) error = paginated.error;
	});

	async function checkForGemmaModel(): Promise<boolean> {
		try {
			const models = (await invoke('get_ollama_models', { endpoint: null })) as Array<{
				name: string;
			}>;
			return models.some((m) => m.name === 'gemma3:1b');
		} catch (err) {
			console.error('Failed to check Ollama models:', err);
			return false;
		}
	}

	async function setupAutoGeneration(): Promise<void> {
		if (hasCheckedAutoGen) return;

		if (source !== 'recording') {
			hasCheckedAutoGen = true;
			return;
		}
		if (!config.isAutoSummary) {
			hasCheckedAutoGen = true;
			return;
		}

		try {
			const currentConfig = (await invoke('api_get_model_config')) as { model?: string } | null;
			if (currentConfig && currentConfig.model) {
				shouldAutoGenerate = true;
				hasCheckedAutoGen = true;
				return;
			}

			const hasGemma = await checkForGemmaModel();
			if (hasGemma) {
				await invoke('api_save_model_config', {
					provider: 'ollama',
					model: '',
					whisperModel: 'large-v3',
					apiKey: null,
					ollamaEndpoint: null
				});
				shouldAutoGenerate = true;
			}
		} catch (err) {
			console.error('Failed to setup auto-generation:', err);
		}
		hasCheckedAutoGen = true;
	}

	// Fetch the persisted summary for a meeting into `meetingSummary`. Shared by
	// the initial load effect and post-generation refresh so both parse identically.
	async function loadSummary(id: string): Promise<void> {
		try {
			const summary = (await invoke('api_get_summary', { meetingId: id })) as {
				status?: string;
				error?: string;
				data?: unknown;
			};

			if (summary.status === 'idle' || (!summary.data && summary.status === 'error')) {
				meetingSummary = null;
				return;
			}

			let parsed: unknown = summary.data ?? {};
			if (typeof parsed === 'string') {
				try {
					parsed = JSON.parse(parsed);
				} catch {
					parsed = {};
				}
			}

			meetingSummary = parsed as Summary;
		} catch (err) {
			console.error('Error fetching meeting summary:', err);
			meetingSummary = null;
		}
	}

	// Load the existing summary whenever the meeting changes.
	let loadedSummaryFor: string | null = null;
	$effect(() => {
		const id = meetingId;

		if (!id || id === 'intro-call') {
			error = 'No meeting selected';
			isLoadingSummary = false;
			void Analytics.trackPageView('meeting_details');
			return;
		}

		if (loadedSummaryFor === id) return;
		loadedSummaryFor = id;

		if (isDevPreview) {
			meetingSummary = devSummary;
			meetingNotes = '- Ask about the mixer test coverage\n- Follow up on VAD latency numbers';
			meetingSummaryContext = 'Attendees: Ana, Bruno. Objective: agree on the Q3 roadmap.';
			error = null;
			isLoadingSummary = false;
			hasCheckedAutoGen = true;
			return;
		}

		meetingSummary = null;
		meetingNotes = '';
		meetingSummaryContext = '';
		error = null;
		isLoadingSummary = true;
		hasCheckedAutoGen = false;
		shouldAutoGenerate = false;

		void (async () => {
			// Load notes before the view renders (isLoadingSummary gates rendering),
			// so they're available when auto-generation folds them into the summary.
			// The same call returns the persisted summary context.
			try {
				const notes = await storageService.getMeetingNotes(id);
				meetingNotes = notes.notesMarkdown;
				meetingSummaryContext = notes.summaryContext;
			} catch (err) {
				console.error('Error fetching meeting notes:', err);
				meetingNotes = '';
				meetingSummaryContext = '';
			}

			try {
				await loadSummary(id);
			} finally {
				isLoadingSummary = false;
			}
		})();
	});

	// Auto-generation check once the meeting is loaded with no summary.
	$effect(() => {
		const details = meetingDetails;
		if (
			details &&
			meetingSummary === null &&
			details.transcripts.length > 0 &&
			!hasCheckedAutoGen
		) {
			void setupAutoGeneration();
		}
	});

	// Stop polling when leaving a meeting.
	$effect(() => {
		const id = meetingId;
		return () => {
			if (id) sidebar.stopSummaryPolling(id);
		};
	});

	async function handleMeetingUpdated(): Promise<void> {
		// Summary generation never changes the transcripts, so we deliberately do
		// NOT call `paginated.refetch()` here. refetch() nulls the metadata, which
		// remounts the keyed details view and reseeds the notes editor + summary
		// from stale parent state — making freshly typed notes (and the just-
		// generated summary) appear to vanish. The summary is already shown via
		// setAiSummary; we just refresh the persisted copy and the sidebar list.
		if (meetingId) await loadSummary(meetingId);
		await sidebar.refetchMeetings();
	}
</script>

{#if error}
	<div class="flex h-screen items-center justify-center">
		<div class="text-center">
			<p class="mb-4 text-destructive">{error}</p>
			<button
				type="button"
				onclick={() => goto('/')}
				class="rounded bg-accent px-4 py-2 text-accent-foreground transition-opacity hover:opacity-90"
			>
				Go Back
			</button>
		</div>
	</div>
{:else if isLoadingSummary || (!isDevPreview && paginated.isLoading) || !meetingDetails}
	<div class="flex h-screen items-center justify-center">
		<Loader class="size-6 animate-spin" />
	</div>
{:else}
	{#key meetingDetails.id}
		<MeetingDetailsView
			meeting={meetingDetails}
		summaryData={meetingSummary}
		notesMarkdown={meetingNotes}
		summaryContext={meetingSummaryContext}
		{shouldAutoGenerate}
		onAutoGenerateComplete={() => (shouldAutoGenerate = false)}
		onMeetingUpdated={handleMeetingUpdated}
		onRefetchTranscripts={paginated.refetch}
		segments={isDevPreview ? devSegments : paginated.segments}
		hasMore={paginated.hasMore}
		isLoadingMore={paginated.isLoadingMore}
		totalCount={paginated.totalCount}
		loadedCount={paginated.loadedCount}
		onLoadMore={paginated.loadMore}
	/>
	{/key}
{/if}
