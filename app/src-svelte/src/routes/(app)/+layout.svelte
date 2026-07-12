<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';

	import { bootStores } from '$lib/stores';
	import { importDialog } from '$lib/stores/import-dialog.svelte';
	import { onboarding } from '$lib/stores/onboarding.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import { summaryLanguage } from '$lib/stores/summary-language.svelte';
	import { analyticsConsent } from '$lib/stores/analytics-consent.svelte';
	import { toast } from '$lib/toast';
	import { recordingService } from '$lib/services/recording';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { isAudioExtension, getAudioFormatsDisplayList } from '$lib/constants/audio-formats';
	import { useUpdateCheck } from '$lib/hooks/use-update-check.svelte';
	import { useRecordingStop } from '$lib/hooks/use-recording-stop.svelte';
	import { FOLDER_PIN_KEY } from '$lib/hooks/use-recording-start.svelte';
	import {
		setUpdateDialogCallback,
		showUpdateNotification,
	} from '$lib/components/update-notification';
	import { Toaster } from '$lib/components/ui/sonner';
	import Sidebar from '$lib/components/Sidebar/Sidebar.svelte';
	import MainContent from '$lib/components/MainContent.svelte';
	import RecordingBar from '$lib/components/RecordingBar.svelte';
	import ChatBar from '$lib/components/ChatBar/ChatBar.svelte';
	import GlobalChatBar from '$lib/components/ChatBar/GlobalChatBar.svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { cn } from '$lib/utils';
	import DownloadProgressToast from '$lib/components/shared/DownloadProgressToast.svelte';
	import ImportDropOverlay from '$lib/components/ImportAudio/ImportDropOverlay.svelte';
	import ImportAudioDialog from '$lib/components/ImportAudio/ImportAudioDialog.svelte';
	import OnboardingFlow from '$lib/components/onboarding/OnboardingFlow.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';

	const { children }: { children: Snippet } = $props();

	const isBrowser = typeof window !== 'undefined';

	// Onboarding gate: mirrors the React layout, which kept the main shell visible
	// until the persisted status resolved, then swapped in the onboarding flow when
	// setup was incomplete. Skipped in browser dev (no Tauri runtime), where
	// onboarding can never complete and would block UI previews.
	const isTauriRuntime = isBrowser && '__TAURI_INTERNALS__' in window;
	const showOnboarding = $derived(
		(isTauriRuntime || !import.meta.env.DEV) && onboarding.statusLoaded && !onboarding.completed,
	);

	// The in-app recording bar shows only while the main window is focused; the
	// floating pill (Rust) covers the backgrounded case. Both read the SAME native
	// window focus — the pill off WindowEvent::Focused, the bar off onFocusChanged —
	// so they stay mutually exclusive (never two stop controls at once).
	let windowFocused = $state(true);
	onMount(() => {
		if (!isTauriRuntime) return;
		const win = getCurrentWindow();
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void win.isFocused().then((focused) => {
			if (!cancelled) windowFocused = focused;
		});
		void win
			.onFocusChanged(({ payload }) => {
				windowFocused = payload;
			})
			.then((fn) => {
				if (cancelled) fn();
				else unlisten = fn;
			});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// ⌘, opens Settings from anywhere (the macOS-standard Preferences shortcut).
	onMount(() => {
		const handleKeydown = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') {
				e.preventDefault();
				void goto('/settings');
			}
		};
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	// Import audio overlay/dialog state (shell-level, mirrors the React layout).
	let showDropOverlay = $state(false);
	let showImportDialog = $state(false);
	let importFilePath = $state<string | null>(null);
	/** OS keychain probe/migration failed — API keys may remain in SQLite. */
	let keychainUnavailable = $state(false);

	// Update-check provider wiring (ports UpdateCheckProvider): check on startup,
	// surface a notification, and render the update dialog from the shell.
	let showUpdateDialog = $state(false);

	function handleShowUpdateDialog(): void {
		showUpdateDialog = true;
	}

	const updateCheck = useUpdateCheck({
		checkOnMount: true,
		onUpdateAvailable: (info) => {
			// Show notification; the dialog opens from the tray path or its callback.
			showUpdateNotification(info);
		},
	});

	// Recording post-processing provider wiring (ports RecordingPostProcessingProvider):
	// the global recording-state store already owns state updates, so the hook's
	// local setters are no-ops here.
	const { handleRecordingStop } = useRecordingStop(
		() => {},
		() => {},
	);

	function handleFileDrop(paths: string[]): void {
		const audioFile = paths.find((p) => {
			const ext = p.split('.').pop()?.toLowerCase();
			return !!ext && isAudioExtension(ext);
		});

		if (audioFile) {
			importFilePath = audioFile;
			showImportDialog = true;
		} else if (paths.length > 0) {
			toast.error('Please drop an audio file', {
				description: `Supported formats: ${getAudioFormatsDisplayList()}`,
			});
		}
	}

	function handleImportDialogClose(next: boolean): void {
		showImportDialog = next;
		if (!next) importFilePath = null;
	}

	// Register the import-dialog store open handler so any component can trigger it.
	$effect(() => {
		const cleanup = importDialog.register((filePath) => {
			importFilePath = filePath ?? null;
			showImportDialog = true;
		});
		return cleanup;
	});

	// Boot stores once. Must be `onMount`, not `$effect`: the store start()
	// functions read reactive state synchronously, so a boot $effect tracks
	// those reads and re-runs when they change. The superseded run's `cancelled`
	// guard then invokes the composite cleanup as soon as its promise resolves,
	// tearing down the singleton Tauri event listeners (live transcript updates
	// silently stop). `onMount` does not track and runs exactly once.
	onMount(() => {
		// Wire runtime theme syncing (the initial class is set by app.html).
		theme.init();
		// Load the saved default summary output language.
		summaryLanguage.init();
		// Initialise analytics once on app start (ports AnalyticsProvider). Gated on the
		// persisted opt-in inside the store's init().
		void analyticsConsent.init();

		let dispose: (() => void) | undefined;
		let cancelled = false;

		bootStores().then((fn) => {
			if (cancelled) fn();
			else dispose = fn;
		});

		return () => {
			cancelled = true;
			dispose?.();
		};
	});

	// Register the update-dialog callback so the notification/tray path can open it
	// (ports UpdateCheckProvider's callback registration).
	$effect(() => {
		setUpdateDialogCallback(handleShowUpdateDialog);
		return () => setUpdateDialogCallback(() => {});
	});

	// Tray "check for updates" listener (ports UpdateCheckProvider's tray handler).
	$effect(() => {
		let unlisten: UnlistenFn | undefined;
		let cancelled = false;

		(async () => {
			try {
				const fn = await listen('check-updates-from-tray', () => {
					void updateCheck.checkForUpdates(true); // Force check from tray.
					showUpdateDialog = true;
				});
				if (cancelled) fn();
				else unlisten = fn;
			} catch (error) {
				console.error('[Layout] Failed to set up update tray listener:', error);
			}
		})();

		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// Meeting auto-detection: when a known meeting app comes to the foreground (and
	// the user enabled auto-detect), offer to start recording.
	$effect(() => {
		let unlisten: UnlistenFn | undefined;
		let cancelled = false;

		(async () => {
			try {
				const fn = await listen<{ app_name: string; bundle_id: string }>(
					'meeting-app-detected',
					(event) => {
						const appName = event.payload?.app_name ?? 'A meeting app';
						toast.info(`${appName} is open`, {
							description: 'Start recording this meeting?',
							duration: 10000,
							action: {
								label: 'Start recording',
								onClick: () => {
									void recordingService.startRecording().catch((error) => {
										toast.error('Failed to start recording', {
											description: error instanceof Error ? error.message : 'Unknown error',
										});
									});
								},
							},
						});
					},
				);
				if (cancelled) fn();
				else unlisten = fn;
			} catch (error) {
				console.error('[Layout] Failed to set up meeting-detect listener:', error);
			}
		})();

		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// Recording post-processing listener (ports RecordingPostProcessingProvider):
	// run the full post-stop flow whenever Rust reports a completed stop, no matter
	// which page the user is on.
	//
	// Guard against a duplicate `recording-stop-complete`: the pill, the in-app bar
	// and the tray can each emit it, and the pipeline (flush → SQLite save →
	// navigate) is not itself idempotent. Re-armed when a new recording begins, so
	// exactly the first completion per recording runs.
	let stopHandled = false;
	$effect(() => {
		if (recordingState.isRecording) stopHandled = false;
	});
	$effect(() => {
		let unlisten: UnlistenFn | undefined;
		let cancelled = false;

		(async () => {
			try {
				const fn = await listen<boolean>('recording-stop-complete', (event) => {
					// event.payload is the callApi boolean (true for normal stops).
					if (stopHandled) return;
					stopHandled = true;
					void handleRecordingStop(event.payload);
				});
				if (cancelled) fn();
				else unlisten = fn;
			} catch (error) {
				console.error('[RecordingPostProcessing] Failed to set up event listener:', error);
			}
		})();

		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// The meeting-start scheduler starts recordings in the backend; it emits the
	// event's identity here so the stop hook can file the note into its pre-assigned
	// folder (even when calendar context is off).
	$effect(() => {
		let unlisten: UnlistenFn | undefined;
		let cancelled = false;
		(async () => {
			try {
				const fn = await listen<{ icalUid: string; occurrenceMinute: number }>(
					'recording-folder-pin',
					(event) => {
						if (typeof sessionStorage !== 'undefined') {
							sessionStorage.setItem(FOLDER_PIN_KEY, JSON.stringify(event.payload));
						}
					},
				);
				if (cancelled) fn();
				else unlisten = fn;
			} catch (error) {
				console.error('[RecordingFolderPin] Failed to set up listener:', error);
			}
		})();
		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// Recording-error listener: Rust emits `recording-error` (a user-facing message
	// string) on capture/transcription startup failures, but nothing listened for it
	// before, so the error was silently swallowed. Surface it as a toast and drive the
	// state machine out of the active state so no surface stays stuck "recording".
	$effect(() => {
		let unlisten: UnlistenFn | undefined;
		let cancelled = false;

		(async () => {
			try {
				const fn = await listen<string>('recording-error', (event) => {
					const message =
						typeof event.payload === 'string' && event.payload.length > 0
							? event.payload
							: 'Recording failed unexpectedly.';
					toast.error(message);
					recordingState.markStopped();
				});
				if (cancelled) fn();
				else unlisten = fn;
			} catch (error) {
				console.error('[Layout] Failed to set up recording-error listener:', error);
			}
		})();

		return () => {
			cancelled = true;
			unlisten?.();
		};
	});

	// Tray recording-toggle + drag-drop import listeners.
	$effect(() => {
		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;

		(async () => {
			try {
				const unlistenTray = await listen('request-recording-toggle', () => {
					if (!onboarding.completed) {
						toast.error('Please complete setup first', {
							description: 'You need to finish onboarding before you can start recording.',
						});
					} else if (isBrowser) {
						// The note editor lives at /note. Route through the shared toggle so
						// this works from any page: start in place if already on the editor,
						// otherwise flag an auto-start and navigate there.
						const intent = sidebar.requestRecordingToggle(window.location.pathname);
						if (intent === 'navigate-editor') void goto('/note');
					}
				});
				if (cancelled) unlistenTray();
				else unsubscribers.push(unlistenTray);

				const unlistenDragEnter = await listen('tauri://drag-enter', () => {
					showDropOverlay = true;
				});
				if (cancelled) unlistenDragEnter();
				else unsubscribers.push(unlistenDragEnter);

				const unlistenDragLeave = await listen('tauri://drag-leave', () => {
					showDropOverlay = false;
				});
				if (cancelled) unlistenDragLeave();
				else unsubscribers.push(unlistenDragLeave);

				const unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
					showDropOverlay = false;
					handleFileDrop(event.payload.paths);
				});
				if (cancelled) unlistenDrop();
				else unsubscribers.push(unlistenDrop);

				// System Audio Recording permission missing (macOS): the Core Audio
				// tap records silence without it, so warn as the recording starts.
				const unlistenAudioPermission = await listen<string>(
					'system-audio-permission-missing',
					(event) => {
						const denied = event.payload === 'denied';
						toast.error(
							denied ? 'System audio is not being captured' : 'System audio may not be captured',
							{
								description: denied
									? "muesly is missing the System Audio Recording permission, so other participants' audio will be silent. Your microphone still records."
									: 'macOS has not granted the System Audio Recording permission yet. If no consent dialog appears, enable muesly manually in System Settings.',
								duration: 12000,
								action: {
									label: 'Open Settings',
									onClick: () => {
										void import('@tauri-apps/api/core').then(({ invoke }) =>
											invoke('open_system_settings', { preferencePane: 'Privacy_ScreenCapture' }),
										);
									},
								},
							},
						);
					},
				);
				if (cancelled) unlistenAudioPermission();
				else unsubscribers.push(unlistenAudioPermission);

				// Silent microphone: backend warns ~10s into a recording if the mic
				// never rose above the silence floor (muted, wrong device, dead hardware).
				const unlistenMicSilent = await listen<{ device?: string | null }>(
					'mic-silent',
					(event) => {
						const device = event.payload?.device;
						toast.error('No audio detected from your microphone', {
							description: device
								? `"${device}" has been silent since recording started. Check the mute switch, or pick a different microphone.`
								: 'Your microphone has been silent since recording started. Check the mute switch, or pick a different microphone.',
							duration: 12000,
						});
					},
				);
				if (cancelled) unlistenMicSilent();
				else unsubscribers.push(unlistenMicSilent);

				// OS keychain unavailable or migration incomplete: API keys may remain
				// in the local SQLite database. Surface this so users are not left on a
				// silent plaintext fallback.
				const unlistenKeychain = await listen('keychain-unavailable', () => {
					keychainUnavailable = true;
					toast.info('OS keychain unavailable', {
						description:
							'Cloud API keys may stay in the local database until the system keychain is set up. Open Settings for details.',
						duration: 15000,
						action: {
							label: 'Open Settings',
							onClick: () => {
								void goto('/settings');
							},
						},
					});
				});
				if (cancelled) unlistenKeychain();
				else unsubscribers.push(unlistenKeychain);
			} catch (error) {
				console.error('[Layout] Failed to set up shell listeners:', error);
			}
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});
</script>

<DownloadProgressToast />

{#if showOnboarding}
	<!-- Overlay title bar: onboarding has no header, so give it a drag strip. -->
	<div data-tauri-drag-region="deep" class="fixed inset-x-0 top-0 z-50 h-8"></div>
	<OnboardingFlow />
{:else}
	<div class="flex">
		<Sidebar />
		<MainContent>
			{#if keychainUnavailable}
				<div
					class="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100"
					role="status"
				>
					<span class="font-medium">OS keychain unavailable.</span>
					Cloud API keys may remain in the local database until the system keychain is set up.
					<button
						type="button"
						class="ml-2 underline underline-offset-2"
						onclick={() => {
							keychainUnavailable = false;
							void goto('/settings');
						}}
					>
						Open Settings
					</button>
					<button
						type="button"
						class="ml-2 text-muted-foreground underline underline-offset-2"
						onclick={() => (keychainUnavailable = false)}
					>
						Dismiss
					</button>
				</div>
			{/if}
			{@render children()}
		</MainContent>
	</div>
{/if}

<!-- In-app recording control, rendered regardless of the onboarding branch so an
     active recording always has a stop button while the window is focused (the
     floating pill covers the unfocused case). Centered in the main content area
     (offset past the sidebar), so it tracks the sidebar collapse. -->
{#if recordingState.isRecording && windowFocused}
	<div
		class={cn('fixed bottom-6 z-40 -translate-x-1/2', 'transition-[left] duration-300')}
		style={`left: calc(50% + ${sidebar.effectiveWidth / 2}px)`}
	>
		<RecordingBar />
	</div>
{/if}

<!-- Floating chat bar. The per-meeting "Ask anything" chat on the note and
     meeting-details views (during AND after a recording); the "Ask your
     meetings" global chat on Home. Same pill + panel surface, different store.
     Stacks above the RecordingBar when both are visible. -->
{#if page.url.pathname === '/' || page.url.pathname === '/note' || page.url.pathname === '/meeting-details'}
	<div
		class={cn(
			'fixed z-40 -translate-x-1/2 transition-[left,bottom] duration-300',
			recordingState.isRecording && windowFocused ? 'bottom-24' : 'bottom-6',
		)}
		style={`left: calc(50% + ${sidebar.effectiveWidth / 2}px)`}
	>
		{#if page.url.pathname === '/'}
			<GlobalChatBar />
		{:else}
			<ChatBar />
		{/if}
	</div>
{/if}

<ImportDropOverlay visible={showDropOverlay} />
<ImportAudioDialog
	open={showImportDialog}
	onOpenChange={handleImportDialogClose}
	preselectedFile={importFilePath}
/>

<UpdateDialog
	open={showUpdateDialog}
	onOpenChange={(next) => (showUpdateDialog = next)}
	updateInfo={updateCheck.updateInfo}
/>

<Toaster position="bottom-right" richColors />
