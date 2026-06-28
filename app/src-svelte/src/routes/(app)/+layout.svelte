<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
	import {
		setUpdateDialogCallback,
		showUpdateNotification
	} from '$lib/components/update-notification';
	import Toaster from '$lib/ui/toaster.svelte';
	import Sidebar from '$lib/components/Sidebar/Sidebar.svelte';
	import MainContent from '$lib/components/MainContent.svelte';
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
		(isTauriRuntime || !import.meta.env.DEV) && onboarding.statusLoaded && !onboarding.completed
	);

	// Import audio overlay/dialog state (shell-level, mirrors the React layout).
	let showDropOverlay = $state(false);
	let showImportDialog = $state(false);
	let importFilePath = $state<string | null>(null);

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
		}
	});

	// Recording post-processing provider wiring (ports RecordingPostProcessingProvider):
	// the global recording-state store already owns state updates, so the hook's
	// local setters are no-ops here.
	const { handleRecordingStop } = useRecordingStop(
		() => {},
		() => {}
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
				description: `Supported formats: ${getAudioFormatsDisplayList()}`
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
											description: error instanceof Error ? error.message : 'Unknown error'
										});
									});
								}
							}
						});
					}
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
	$effect(() => {
		let unlisten: UnlistenFn | undefined;
		let cancelled = false;

		(async () => {
			try {
				const fn = await listen<boolean>('recording-stop-complete', (event) => {
					// event.payload is the callApi boolean (true for normal stops).
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
							description: 'You need to finish onboarding before you can start recording.'
						});
					} else if (isBrowser) {
						window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
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
							denied
								? 'System audio is not being captured'
								: 'System audio may not be captured',
							{
								description: denied
									? "muesly is missing the System Audio Recording permission, so other participants' audio will be silent. Your microphone still records."
									: 'macOS has not granted the System Audio Recording permission yet. If no consent dialog appears, enable muesly manually in System Settings.',
								duration: 12000,
								action: {
									label: 'Open Settings',
									onClick: () => {
										void import('@tauri-apps/api/core').then(({ invoke }) =>
											invoke('open_system_settings', { preferencePane: 'Privacy_ScreenCapture' })
										);
									}
								}
							}
						);
					}
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
							duration: 12000
						});
					}
				);
				if (cancelled) unlistenMicSilent();
				else unsubscribers.push(unlistenMicSilent);
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
			{@render children()}
		</MainContent>
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

<Toaster />
