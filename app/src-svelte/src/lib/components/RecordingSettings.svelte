<script lang="ts" module>
	export interface RecordingPreferences {
		save_folder: string;
		auto_save: boolean;
		file_format: string;
		preferred_mic_device: string | null;
		preferred_system_device: string | null;
	}
</script>

<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { FolderOpen } from '@lucide/svelte';
	import { onMount } from 'svelte';

	import { Analytics } from '$lib/analytics';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { toast } from '$lib/toast';
	import Loadable from '$lib/components/Loadable.svelte';
	import DeviceSelection, { type SelectedDevices } from './DeviceSelection.svelte';
	import DictationCleanupSettings from './DictationCleanupSettings.svelte';
	import { config } from '$lib/stores/config.svelte';
	import { commands } from '$lib/bindings';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import { formatAccelerator } from '$lib/shortcut-accel';

	let preferences = $state<RecordingPreferences>({
		save_folder: '',
		auto_save: true,
		file_format: 'mp4',
		preferred_mic_device: null,
		preferred_system_device: null,
	});
	let loading = $state(true);
	let saving = $state(false);
	let notificationSaving = $state(false);
	let automationSaving = $state<string | null>(null);
	let showRecordingNotification = $state(true);
	let autoDetectMeetings = $state(false);
	let autoStartOnEvent = $state(false);
	let autoJoinMeeting = $state(false);
	let dictationEnabled = $state(false);
	// macOS Accessibility permission, needed to paste dictated text into other apps.
	let accessibilityTrusted = $state(true);

	// Live shortcut labels (rebindable in General → Keyboard shortcuts).
	const platform = usePlatform();
	let recordingAccel = $state<string | null>(null);
	let dictationAccel = $state<string | null>(null);

	onMount(() => {
		void (async () => {
			try {
				preferences = await invoke<RecordingPreferences>('get_recording_preferences');
			} catch (error) {
				console.error('Failed to load recording preferences:', error);
				try {
					const defaultPath = await invoke<string>('get_default_recordings_folder_path');
					preferences = { ...preferences, save_folder: defaultPath };
				} catch (defaultError) {
					console.error('Failed to get default folder path:', defaultError);
				}
			} finally {
				loading = false;
			}
		})();

		void (async () => {
			try {
				const { Store } = await import('@tauri-apps/plugin-store');
				const store = await Store.load('preferences.json');
				showRecordingNotification =
					(await store.get<boolean>('show_recording_notification')) ?? true;
			} catch (error) {
				console.error('Failed to load notification preference:', error);
			}
		})();

		void (async () => {
			const res = await commands.getAutoDetectMeetings();
			if (res.status === 'ok') autoDetectMeetings = res.data;
		})();

		void (async () => {
			const start = await commands.calendarGetAutoStartOnEvent();
			if (start.status === 'ok') autoStartOnEvent = start.data;
			const join = await commands.calendarGetAutoJoinMeeting();
			if (join.status === 'ok') autoJoinMeeting = join.data;
		})();

		void (async () => {
			const enabled = await commands.getDictationEnabled();
			if (enabled.status === 'ok') dictationEnabled = enabled.data;
			const trusted = await commands.dictationAccessibilityTrusted();
			if (trusted.status === 'ok') accessibilityTrusted = trusted.data;
		})();

		void (async () => {
			const [rec, dic] = await Promise.all([
				commands.getRecordingShortcut(),
				commands.getDictationShortcut(),
			]);
			if (rec.status === 'ok') recordingAccel = rec.data.accelerator;
			if (dic.status === 'ok') dictationAccel = dic.data.accelerator;
		})();
	});

	async function handleDictationToggle(enabled: boolean): Promise<void> {
		automationSaving = 'dictation';
		dictationEnabled = enabled;
		// Enabling keeps the engine warm and registers the push-to-talk hotkey.
		const warm = await commands.setDictationEnabled(enabled);
		const hotkey = await commands.setDictationShortcutEnabled(enabled);
		if (warm.status === 'error' || hotkey.status === 'error') {
			dictationEnabled = !enabled;
			toast.error('Failed to update dictation', {
				description: warm.status === 'error' ? warm.error : (hotkey as { error?: string }).error,
			});
			automationSaving = null;
			return;
		}
		if (enabled) {
			const trusted = await commands.dictationAccessibilityTrusted();
			if (trusted.status === 'ok') accessibilityTrusted = trusted.data;
		}
		automationSaving = null;
	}

	async function handleAutoDetectToggle(enabled: boolean): Promise<void> {
		automationSaving = 'detection';
		autoDetectMeetings = enabled;
		const res = await commands.setAutoDetectMeetings(enabled);
		if (res.status === 'error') {
			autoDetectMeetings = !enabled;
			toast.error('Failed to update meeting auto-detection', { description: res.error });
		}
		automationSaving = null;
	}

	async function handleAutoStartToggle(enabled: boolean): Promise<void> {
		automationSaving = 'auto-start';
		autoStartOnEvent = enabled;
		const res = await commands.calendarSetAutoStartOnEvent(enabled);
		if (res.status === 'error') {
			autoStartOnEvent = !enabled;
			toast.error('Failed to update auto-start', { description: res.error });
			automationSaving = null;
			return;
		}
		automationSaving = null;
		// A denied Calendar permission would leave this silently never firing.
		if (enabled) {
			const perm = await commands.calendarPermissionStatus();
			if (perm !== 'granted') {
				toast.info('Calendar access needed', {
					description: 'Grant Calendar access so muesly can detect when your meetings start.',
				});
			}
		}
	}

	async function handleAutoJoinToggle(enabled: boolean): Promise<void> {
		automationSaving = 'auto-join';
		autoJoinMeeting = enabled;
		const res = await commands.calendarSetAutoJoinMeeting(enabled);
		if (res.status === 'error') {
			autoJoinMeeting = !enabled;
			toast.error('Failed to update auto-join', { description: res.error });
		}
		automationSaving = null;
	}

	async function savePreferences(prefs: RecordingPreferences): Promise<boolean> {
		saving = true;
		try {
			await invoke('set_recording_preferences', { preferences: prefs });
			return true;
		} catch (error) {
			console.error('Failed to save recording preferences:', error);
			toast.error('Failed to save recording preferences', {
				description: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			saving = false;
		}
	}

	async function handleAutoSaveToggle(enabled: boolean): Promise<void> {
		const previous = preferences;
		preferences = { ...preferences, auto_save: enabled };
		if (!(await savePreferences(preferences))) {
			preferences = previous;
			return;
		}
		Analytics.track('auto_save_recording_toggled', { enabled: enabled.toString() }).catch((err) =>
			console.error('Failed to track auto-save toggle:', err),
		);
	}

	async function handleDeviceChange(devices: SelectedDevices): Promise<void> {
		const previousPreferences = preferences;
		const previousDevices = config.selectedDevices;
		preferences = {
			...preferences,
			preferred_mic_device: devices.micDevice,
			preferred_system_device: devices.systemDevice,
		};
		// Apply to the live config too, not just the persisted preference: UI-started
		// recordings read `config.selectedDevices`, so without this the change didn't
		// take effect until the next app launch.
		config.setSelectedDevices(devices);
		if (!(await savePreferences(preferences))) {
			preferences = previousPreferences;
			config.setSelectedDevices(previousDevices);
			return;
		}
		Analytics.track('default_devices_changed', {
			has_preferred_microphone: (!!devices.micDevice).toString(),
			has_preferred_system_audio: (!!devices.systemDevice).toString(),
		}).catch((err) => console.error('Failed to track device change:', err));
	}

	async function handleOpenFolder(): Promise<void> {
		try {
			await invoke('open_recordings_folder');
		} catch (error) {
			console.error('Failed to open recordings folder:', error);
			toast.error('Could not open the recordings folder', {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function handleNotificationToggle(enabled: boolean): Promise<void> {
		const previous = showRecordingNotification;
		notificationSaving = true;
		try {
			showRecordingNotification = enabled;
			const { Store } = await import('@tauri-apps/plugin-store');
			const store = await Store.load('preferences.json');
			await store.set('show_recording_notification', enabled);
			await store.save();
			await Analytics.track('recording_notification_preference_changed', {
				enabled: enabled.toString(),
			});
		} catch (error) {
			showRecordingNotification = previous;
			console.error('Failed to save notification preference:', error);
			toast.error('Failed to save preference');
		} finally {
			notificationSaving = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<p class="text-pretty text-sm text-muted-foreground">
		Configure capture, meeting automation, dictation, and default devices.
	</p>
	<Loadable {loading}>
		<Card.Root>
			<Card.Header>
				<Card.Title>Capture</Card.Title>
				<Card.Description
					>Choose what Muesly saves and how recording is communicated.</Card.Description
				>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="min-w-0 flex-1">
						<div id="save-recordings-label" class="font-medium">Save audio recordings</div>
						<div class="text-sm text-muted-foreground">
							Automatically save audio files when recording stops
						</div>
					</div>
					<Switch
						checked={preferences.auto_save}
						disabled={saving}
						aria-labelledby="save-recordings-label"
						onCheckedChange={handleAutoSaveToggle}
					/>
				</div>

				{#if preferences.auto_save}
					<div class="flex flex-col gap-4">
						<div class="rounded-lg bg-muted/35 p-4">
							<div class="mb-2 font-medium">Save location</div>
							<div class="mb-3 break-all text-sm text-muted-foreground">
								{preferences.save_folder || 'Default folder'}
							</div>
							<Button variant="outline" size="sm" onclick={handleOpenFolder}>
								<FolderOpen data-icon="inline-start" /> Open folder
							</Button>
						</div>

						<div class="rounded-lg border border-brand/20 bg-brand/5 p-4">
							<div class="text-sm text-foreground">
								<strong>File format:</strong>
								{preferences.file_format.toUpperCase()} files
							</div>
							<div class="mt-1 text-xs text-muted-foreground">
								Recordings are saved with timestamp: recording_YYYYMMDD_HHMMSS.{preferences.file_format}
							</div>
						</div>
					</div>
				{:else}
					<Alert.Root class="border-warning/30 text-warning">
						<Alert.Description class="text-warning/90">
							Audio recording is disabled. Enable "Save Audio Recordings" to automatically save your
							meeting audio.
						</Alert.Description>
					</Alert.Root>
				{/if}

				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="min-w-0 flex-1">
						<div id="recording-consent-label" class="font-medium">Recording consent reminder</div>
						<div class="text-sm text-muted-foreground">
							Show an in-app banner reminding you to tell participants a recording has started
						</div>
					</div>
					<Switch
						checked={showRecordingNotification}
						disabled={notificationSaving}
						aria-labelledby="recording-consent-label"
						onCheckedChange={handleNotificationToggle}
					/>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Automation</Card.Title>
				<Card.Description
					>Control recording from anywhere and respond to meetings automatically.</Card.Description
				>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="min-w-0 flex-1">
						<div id="global-recording-label" class="font-medium">Global recording shortcut</div>
						<div class="text-sm text-muted-foreground">
							Start or stop a recording with
							{recordingAccel ? formatAccelerator(recordingAccel, platform.isMac) : 'the shortcut'}
							from any app. Rebind it in General settings.
						</div>
					</div>
					<Switch
						checked={config.globalShortcutEnabled}
						aria-labelledby="global-recording-label"
						onCheckedChange={(enabled) => config.toggleGlobalShortcut(enabled)}
					/>
				</div>

				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="min-w-0 flex-1">
						<div id="detect-meetings-label" class="font-medium">Automatically detect meetings</div>
						<div class="text-sm text-muted-foreground">
							When a meeting app (Zoom, Teams, Webex) comes to the front, offer to start recording.
							macOS only.
						</div>
					</div>
					<Switch
						checked={autoDetectMeetings}
						disabled={automationSaving === 'detection'}
						aria-labelledby="detect-meetings-label"
						onCheckedChange={handleAutoDetectToggle}
					/>
				</div>

				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="min-w-0 flex-1">
						<div id="auto-start-label" class="font-medium">
							Start recording when a meeting begins
						</div>
						<div class="text-sm text-muted-foreground">
							When a calendar meeting with attendees starts, automatically record it. Off by
							default.
						</div>
					</div>
					<Switch
						checked={autoStartOnEvent}
						disabled={automationSaving === 'auto-start'}
						aria-labelledby="auto-start-label"
						onCheckedChange={handleAutoStartToggle}
					/>
				</div>

				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
					class:opacity-60={!autoStartOnEvent}
				>
					<div class="min-w-0 flex-1">
						<div id="auto-join-label" class="font-medium">Open the meeting link too</div>
						<div class="text-sm text-muted-foreground">
							On auto-start, also open the meeting's video link (Zoom, Meet, Teams) in your browser.
						</div>
					</div>
					<Switch
						checked={autoJoinMeeting}
						onCheckedChange={handleAutoJoinToggle}
						disabled={!autoStartOnEvent || automationSaving === 'auto-join'}
						aria-labelledby="auto-join-label"
					/>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Dictation</Card.Title>
				<Card.Description
					>Insert locally transcribed speech into the app you are using.</Card.Description
				>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				<div
					class="flex flex-col gap-4 rounded-lg bg-muted/35 p-4 sm:flex-row sm:items-center sm:justify-between"
				>
					<div class="min-w-0 flex-1">
						<div id="dictation-label" class="font-medium">Push-to-talk dictation</div>
						<div class="text-sm text-muted-foreground">
							Hold {dictationAccel
								? formatAccelerator(dictationAccel, platform.isMac)
								: 'the hotkey'}
							to dictate; on release the transcribed text is inserted into the focused app. Keeps the
							model warm. macOS needs Accessibility permission.
						</div>
						{#if dictationEnabled && !accessibilityTrusted}
							<div class="mt-2 text-sm text-destructive">
								Accessibility permission is required to insert text. Grant it in System Settings →
								Privacy &amp; Security → Accessibility.
							</div>
						{/if}
					</div>
					<Switch
						checked={dictationEnabled}
						disabled={automationSaving === 'dictation'}
						aria-labelledby="dictation-label"
						onCheckedChange={handleDictationToggle}
					/>
				</div>

				{#if dictationEnabled}
					<DictationCleanupSettings />
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Default audio devices</Card.Title>
				<Card.Description>
					Set your preferred microphone and system audio devices for recording. These will be
					automatically selected when starting new recordings.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="rounded-lg bg-muted/35 p-4">
					<DeviceSelection
						selectedDevices={{
							micDevice: preferences.preferred_mic_device,
							systemDevice: preferences.preferred_system_device,
						}}
						onDeviceChange={handleDeviceChange}
						disabled={saving}
					/>
				</div>
			</Card.Content>
		</Card.Root>
	</Loadable>
</div>
