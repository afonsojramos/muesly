/**
 * Sidebar store.
 *
 * Meeting list, current selection, sidebar collapse, transcript search, and
 * the summary-polling Map. Equivalent of the React SidebarProvider.
 *
 * Navigation concerns (`router.push`, `pathname`) are component-level — they
 * use SvelteKit's `goto` and `$app/state.page` instead of being threaded
 * through the store.
 */

import { invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';

import { Analytics } from '$lib/analytics';
import { recordingState } from './recording-state.svelte';

export interface CurrentMeeting {
	id: string;
	title: string;
	createdAt?: string;
	/** Organizing folder id (undefined = uncategorized). */
	folderId?: string;
}

export interface Folder {
	id: string;
	name: string;
	emoji?: string | null;
	createdAt?: string;
}

export interface SidebarItem {
	id: string;
	title: string;
	type: 'folder' | 'file';
	createdAt?: string;
	children?: SidebarItem[];
}

export interface TranscriptSearchResult {
	id: string;
	title: string;
	matchContext: string;
	timestamp: string;
}

interface SummaryPollResult {
	status: 'idle' | 'processing' | 'completed' | 'error' | 'failed' | 'cancelled' | string;
	error?: string;
	[key: string]: unknown;
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 200; // ~16.5 minutes

// User-adjustable sidebar width (persisted), and the fixed collapsed rail width.
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_COLLAPSED_WIDTH = 0;
const SIDEBAR_WIDTH_KEY = 'muesly-sidebar-width';

function loadSidebarWidth(): number {
	if (typeof window === 'undefined') return 256;
	const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
	return saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH ? saved : 256;
}

class SidebarStore {
	currentMeeting = $state<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
	isCollapsed = $state<boolean>(false);
	/** Expanded-state width in px, user-adjustable via the resize handle. */
	width = $state<number>(loadSidebarWidth());
	/** True while the user is dragging the resize handle (disables transitions). */
	isResizing = $state<boolean>(false);
	meetings = $state<CurrentMeeting[]>([]);
	folders = $state<Folder[]>([]);
	isMeetingActive = $state<boolean>(false);
	searchResults = $state<TranscriptSearchResult[]>([]);
	isSearching = $state<boolean>(false);

	readonly activeSummaryPolls = new SvelteMap<string, ReturnType<typeof setInterval>>();

	get sidebarItems(): SidebarItem[] {
		return [
			{
				id: 'meetings',
				title: 'Notes',
				type: 'folder',
				children: this.meetings.map(
					(m): SidebarItem => ({ id: m.id, title: m.title, type: 'file', createdAt: m.createdAt }),
				),
			},
		];
	}

	async start(): Promise<() => void> {
		await Promise.allSettled([this.refetchMeetings(), this.refetchFolders()]);
		return () => this.#cleanup();
	}

	toggleCollapse = (): void => {
		this.isCollapsed = !this.isCollapsed;
	};

	/** Current rendered width: 0 when closed, else the user-set width. */
	get effectiveWidth(): number {
		return this.isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : this.width;
	}

	setWidth = (w: number): void => {
		this.width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
	};

	persistWidth = (): void => {
		if (typeof window !== 'undefined') {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, String(this.width));
		}
	};

	setCurrentMeeting = (meeting: CurrentMeeting | null): void => {
		this.currentMeeting = meeting;
	};

	setIsMeetingActive = (active: boolean): void => {
		this.isMeetingActive = active;
	};

	refetchMeetings = async (): Promise<void> => {
		try {
			const list = (await invoke('api_get_meetings')) as Array<{
				id: string;
				title: string;
				created_at?: string;
				folder_id?: string | null;
			}>;
			this.meetings = list.map((m) => ({
				id: m.id,
				title: m.title,
				createdAt: m.created_at,
				folderId: m.folder_id ?? undefined,
			}));
		} catch (error) {
			// Browser dev preview (vite dev without Tauri): sample notes so the
			// sidebar layout/date grouping can be exercised visually.
			if (
				import.meta.env.DEV &&
				typeof window !== 'undefined' &&
				!('__TAURI_INTERNALS__' in window)
			) {
				const day = 86400000;
				const at = (offsetDays: number, hour: number): string =>
					new Date(Date.now() - offsetDays * day).toISOString().slice(0, 11) +
					`${String(hour).padStart(2, '0')}:30:00Z`;
				this.meetings = [
					{ id: 'dev-1', title: 'Team standup', createdAt: at(0, 9), folderId: 'dev-folder-1' },
					{ id: 'dev-2', title: 'Design review with Sarah', createdAt: at(0, 7) },
					{ id: 'dev-3', title: 'Q3 planning', createdAt: at(1, 14), folderId: 'dev-folder-1' },
					{ id: 'dev-4', title: '1:1 with Alex', createdAt: at(1, 10) },
					{ id: 'dev-5', title: 'Customer call: Acme Corp', createdAt: at(4, 15) },
					{ id: 'dev-6', title: 'Roadmap sync', createdAt: at(12, 11) },
				];
				this.folders = [{ id: 'dev-folder-1', name: 'Team' }];
				return;
			}
			console.error('[SidebarStore] Failed to fetch meetings:', error);
			this.meetings = [];
		}
	};

	refetchFolders = async (): Promise<void> => {
		try {
			const list = (await invoke('api_list_folders')) as Array<{
				id: string;
				name: string;
				emoji?: string | null;
				created_at?: string;
			}>;
			this.folders = list.map((f) => ({
				id: f.id,
				name: f.name,
				emoji: f.emoji ?? null,
				createdAt: f.created_at,
			}));
		} catch (error) {
			// In browser dev preview the sample folders set by refetchMeetings stand in.
			if (
				import.meta.env.DEV &&
				typeof window !== 'undefined' &&
				!('__TAURI_INTERNALS__' in window)
			) {
				return;
			}
			console.error('[SidebarStore] Failed to fetch folders:', error);
			this.folders = [];
		}
	};

	createFolder = async (name: string, emoji: string | null = null): Promise<void> => {
		await invoke('api_create_folder', { name, emoji });
		await this.refetchFolders();
	};

	updateFolder = async (
		folderId: string,
		name: string,
		emoji: string | null = null,
	): Promise<void> => {
		await invoke('api_update_folder', { folderId, name, emoji });
		await this.refetchFolders();
	};

	deleteFolder = async (folderId: string): Promise<void> => {
		await invoke('api_delete_folder', { folderId });
		// Meetings are detached server-side; refresh both lists.
		await Promise.allSettled([this.refetchFolders(), this.refetchMeetings()]);
	};

	moveMeetingToFolder = async (meetingId: string, folderId: string | null): Promise<void> => {
		await invoke('api_move_meeting_to_folder', { meetingId, folderId });
		await this.refetchMeetings();
	};

	searchTranscripts = async (query: string): Promise<void> => {
		if (!query.trim()) {
			this.searchResults = [];
			return;
		}

		try {
			this.isSearching = true;
			const results = (await invoke('api_search_transcripts', {
				query,
			})) as TranscriptSearchResult[];
			this.searchResults = results;
		} catch (error) {
			console.error('[SidebarStore] Search failed:', error);
			this.searchResults = [];
		} finally {
			this.isSearching = false;
		}
	};

	/** Begin polling for a summary result. Idempotent per meeting ID. */
	startSummaryPolling = (
		meetingId: string,
		processId: string,
		onUpdate: (result: SummaryPollResult) => void,
	): void => {
		const existing = this.activeSummaryPolls.get(meetingId);
		if (existing) clearInterval(existing);

		let pollCount = 0;

		const interval = setInterval(async () => {
			pollCount++;

			if (pollCount >= MAX_POLLS) {
				clearInterval(interval);
				this.activeSummaryPolls.delete(meetingId);
				onUpdate({
					status: 'error',
					error:
						'Summary generation timed out after 15 minutes. Please try again or check your model configuration.',
				});
				return;
			}

			try {
				const result = (await invoke('api_get_summary', { meetingId })) as SummaryPollResult;
				onUpdate(result);

				const terminal =
					result.status === 'completed' ||
					result.status === 'error' ||
					result.status === 'failed' ||
					result.status === 'cancelled';
				const idleAfterStart = result.status === 'idle' && pollCount > 1;

				if (terminal || idleAfterStart) {
					clearInterval(interval);
					this.activeSummaryPolls.delete(meetingId);
				}
			} catch (error) {
				onUpdate({
					status: 'error',
					error: error instanceof Error ? error.message : 'Unknown error',
				});
				clearInterval(interval);
				this.activeSummaryPolls.delete(meetingId);
			}
		}, POLL_INTERVAL_MS);

		this.activeSummaryPolls.set(meetingId, interval);
		console.log(`[SidebarStore] Started polling for ${meetingId}, process ${processId}`);
	};

	stopSummaryPolling = (meetingId: string): void => {
		const interval = this.activeSummaryPolls.get(meetingId);
		if (interval) {
			clearInterval(interval);
			this.activeSummaryPolls.delete(meetingId);
		}
	};

	/**
	 * Handle the "toggle recording from sidebar" action. Returns navigation
	 * intent so the caller (a component with SvelteKit's `goto`) can execute
	 * it — this keeps router calls out of the store layer.
	 */
	requestRecordingToggle = (currentPath: string): 'on-editor' | 'navigate-editor' | 'noop' => {
		if (recordingState.isRecording) return 'noop';

		Analytics.track('button_click', { name: 'start_recording', location: 'sidebar' }).catch((err) =>
			console.error('Analytics track failed:', err),
		);

		// The note editor lives at /note; recording happens there. If already on it,
		// start in place; otherwise flag an auto-start and let the caller navigate.
		if (currentPath === '/note') {
			if (typeof window !== 'undefined') {
				window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
			}
			return 'on-editor';
		}

		if (typeof window !== 'undefined') {
			sessionStorage.setItem('autoStartRecording', 'true');
		}
		return 'navigate-editor';
	};

	#cleanup(): void {
		for (const interval of this.activeSummaryPolls.values()) {
			clearInterval(interval);
		}
		this.activeSummaryPolls.clear();
	}
}

export const sidebar = new SidebarStore();
