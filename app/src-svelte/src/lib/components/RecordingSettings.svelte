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
	import { Button } from '$lib/components/ui/button';
	import { Separator } from '$lib/components/ui/separator';
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
		dictationEnabled = enabled;
		// Enabling keeps the engine warm and registers the push-to-talk hotkey.
		const warm = await commands.setDictationEnabled(enabled);
		const hotkey = await commands.setDictationShortcutEnabled(enabled);
		if (warm.status === 'error' || hotkey.status === 'error') {
			dictationEnabled = !enabled;
			toast.error('Failed to update dictation', {
				description: warm.status === 'error' ? warm.error : (hotkey as { error?: string }).error,
			});
			return;
		}
		if (enabled) {
			const trusted = await commands.dictationAccessibilityTrusted();
			if (trusted.status === 'ok') accessibilityTrusted = trusted.data;
		}
	}

	async function handleAutoDetectToggle(enabled: boolean): Promise<void> {
		autoDetectMeetings = enabled;
		const res = await commands.setAutoDetectMeetings(enabled);
		if (res.status === 'error') {
			autoDetectMeetings = !enabled;
			toast.error('Failed to update meeting auto-detection', { description: res.error });
		}
	}

	async function handleAutoStartToggle(enabled: boolean): Promise<void> {
		autoStartOnEvent = enabled;
		const res = await commands.calendarSetAutoStartOnEvent(enabled);
		if (res.status === 'error') {
			autoStartOnEvent = !enabled;
			toast.error('Failed to update auto-start', { description: res.error });
			return;
		}
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
		autoJoinMeeting = enabled;
		const res = await commands.calendarSetAutoJoinMeeting(enabled);
		if (res.status === 'error') {
			autoJoinMeeting = !enabled;
			toast.error('Failed to update auto-join', { description: res.error });
		}
	}

	async function savePreferences(prefs: RecordingPreferences): Promise<void> {
		saving = true;
		try {
			await invoke('set_recording_preferences', { preferences: prefs });
			const micDevice = prefs.preferred_mic_device || 'Default';
			const systemDevice = prefs.preferred_system_device || 'Default';
			toast.success('Device preferences saved', {
				description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`,
			});
		} catch (error) {
			console.error('Failed to save recording preferences:', error);
			toast.error('Failed to save device preferences', {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			saving = false;
		}
	}

	async function handleAutoSaveToggle(enabled: boolean): Promise<void> {
		preferences = { ...preferences, auto_save: enabled };
		await savePreferences(preferences);
		Analytics.track('auto_save_recording_toggled', { enabled: enabled.toString() }).catch((err) =>
			console.error('Failed to track auto-save toggle:', err),
		);
	}

	async function handleDeviceChange(devices: SelectedDevices): Promise<void> {
		preferences = {
			...preferences,
			preferred_mic_device: devices.micDevice,
			preferred_system_device: devices.systemDevice,
		};
		// Apply to the live config too, not just the persisted preference: UI-started
		// recordings read `config.selectedDevices`, so without this the change didn't
		// take effect until the next app launch.
		config.setSelectedDevices(devices);
		await savePreferences(preferences);
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
		}
	}

	async function handleNotificationToggle(enabled: boolean): Promise<void> {
		try {
			showRecordingNotification = enabled;
			const { Store } = await import('@tauri-apps/plugin-store');
			const store = await Store.load('preferences.json');
			await store.set('show_recording_notification', enabled);
			await store.save();
			toast.success('Preference saved');
			await Analytics.track('recording_notification_preference_changed', {
				enabled: enabled.toString(),
			});
		} catch (error) {
			console.error('Failed to save notification preference:', error);
			toast.error('Failed to save preference');
		}
	}
</script>

<div class="flex flex-col gap-6">
	<div>
		<p class="mb-6 text-sm text-muted-foreground">
			Configure how your audio recordings are saved during meetings.
		</p>
	</div>
	<Loadable {loading}>
		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Save Audio Recordings</div>
				<div class="text-sm text-muted-foreground">
					Automatically save audio files when recording stops
				</div>
			</div>
			<Switch
				checked={preferences.auto_save}
				disabled={saving}
				onCheckedChange={handleAutoSaveToggle}
			/>
		</div>

		{#if preferences.auto_save}
			<div class="flex flex-col gap-4">
				<div class="rounded-lg border border-border bg-secondary/40 p-4">
					<div class="mb-2 font-medium">Save Location</div>
					<div class="mb-3 break-all text-sm text-muted-foreground">
						{preferences.save_folder || 'Default folder'}
					</div>
					<Button variant="outline" size="sm" onclick={handleOpenFolder}>
						<FolderOpen data-icon="inline-start" /> Open Folder
					</Button>
				</div>

				<div class="rounded-lg border border-brand/20 bg-brand/5 p-4">
					<div class="text-sm text-foreground">
						<strong>File Format:</strong>
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

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Recording Start Notification</div>
				<div class="text-sm text-muted-foreground">
					Show reminder to inform participants when recording starts
				</div>
			</div>
			<Switch checked={showRecordingNotification} onCheckedChange={handleNotificationToggle} />
		</div>

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Global recording shortcut</div>
				<div class="text-sm text-muted-foreground">
					Start or stop a recording with
					{recordingAccel ? formatAccelerator(recordingAccel, platform.isMac) : 'the shortcut'}
					from any app. Rebind it in General settings.
				</div>
			</div>
			<Switch
				checked={config.globalShortcutEnabled}
				onCheckedChange={(enabled) => config.toggleGlobalShortcut(enabled)}
			/>
		</div>

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Automatically detect meetings</div>
				<div class="text-sm text-muted-foreground">
					When a meeting app (Zoom, Teams, Webex) comes to the front, offer to start recording.
					macOS only.
				</div>
			</div>
			<Switch checked={autoDetectMeetings} onCheckedChange={handleAutoDetectToggle} />
		</div>

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Start recording when a meeting begins</div>
				<div class="text-sm text-muted-foreground">
					When a calendar meeting with attendees starts, automatically record it. Off by default.
				</div>
			</div>
			<Switch checked={autoStartOnEvent} onCheckedChange={handleAutoStartToggle} />
		</div>

		<div
			class="flex items-center justify-between rounded-lg border border-border p-4"
			class:opacity-60={!autoStartOnEvent}
		>
			<div class="flex-1">
				<div class="font-medium">Open the meeting link too</div>
				<div class="text-sm text-muted-foreground">
					On auto-start, also open the meeting's video link (Zoom, Meet, Teams) in your browser.
				</div>
			</div>
			<Switch
				checked={autoJoinMeeting}
				onCheckedChange={handleAutoJoinToggle}
				disabled={!autoStartOnEvent}
			/>
		</div>

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Push-to-talk dictation</div>
				<div class="text-sm text-muted-foreground">
					Hold {dictationAccel ? formatAccelerator(dictationAccel, platform.isMac) : 'the hotkey'}
					to dictate; on release the transcribed text is inserted into the focused app. Keeps the model
					warm. macOS needs Accessibility permission.
				</div>
				{#if dictationEnabled && !accessibilityTrusted}
					<div class="mt-2 text-sm text-destructive">
						Accessibility permission is required to insert text. Grant it in System Settings →
						Privacy &amp; Security → Accessibility.
					</div>
				{/if}
			</div>
			<Switch checked={dictationEnabled} onCheckedChange={handleDictationToggle} />
		</div>

		{#if dictationEnabled}
			<DictationCleanupSettings />
		{/if}

		<Separator />

		<div class="flex flex-col gap-4">
			<div>
				<h4 class="mb-4 text-base font-medium">Default Audio Devices</h4>
				<p class="mb-4 text-sm text-muted-foreground">
					Set your preferred microphone and system audio devices for recording. These will be
					automatically selected when starting new recordings.
				</p>

				<div class="rounded-lg border border-border bg-secondary/40 p-4">
					<DeviceSelection
						selectedDevices={{
							micDevice: preferences.preferred_mic_device,
							systemDevice: preferences.preferred_system_device,
						}}
						onDeviceChange={handleDeviceChange}
						disabled={saving}
					/>
				</div>
			</div>
		</div>
	</Loadable>
</div>
