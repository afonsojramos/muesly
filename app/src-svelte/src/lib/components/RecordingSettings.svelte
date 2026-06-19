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
	import Switch from '$lib/ui/switch.svelte';
	import { toast } from '$lib/toast';
	import DeviceSelection, { type SelectedDevices } from './DeviceSelection.svelte';
	import { config } from '$lib/stores/config.svelte';
	import { commands } from '$lib/bindings';

	let preferences = $state<RecordingPreferences>({
		save_folder: '',
		auto_save: true,
		file_format: 'mp4',
		preferred_mic_device: null,
		preferred_system_device: null
	});
	let loading = $state(true);
	let saving = $state(false);
	let showRecordingNotification = $state(true);
	let autoDetectMeetings = $state(false);

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
				showRecordingNotification = (await store.get<boolean>('show_recording_notification')) ?? true;
			} catch (error) {
				console.error('Failed to load notification preference:', error);
			}
		})();

		void (async () => {
			const res = await commands.getAutoDetectMeetings();
			if (res.status === 'ok') autoDetectMeetings = res.data;
		})();
	});

	async function handleAutoDetectToggle(enabled: boolean): Promise<void> {
		autoDetectMeetings = enabled;
		const res = await commands.setAutoDetectMeetings(enabled);
		if (res.status === 'error') {
			autoDetectMeetings = !enabled;
			toast.error('Failed to update meeting auto-detection', { description: res.error });
		}
	}

	async function savePreferences(prefs: RecordingPreferences): Promise<void> {
		saving = true;
		try {
			await invoke('set_recording_preferences', { preferences: prefs });
			const micDevice = prefs.preferred_mic_device || 'Default';
			const systemDevice = prefs.preferred_system_device || 'Default';
			toast.success('Device preferences saved', {
				description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`
			});
		} catch (error) {
			console.error('Failed to save recording preferences:', error);
			toast.error('Failed to save device preferences', {
				description: error instanceof Error ? error.message : String(error)
			});
		} finally {
			saving = false;
		}
	}

	async function handleAutoSaveToggle(enabled: boolean): Promise<void> {
		preferences = { ...preferences, auto_save: enabled };
		await savePreferences(preferences);
		Analytics.track('auto_save_recording_toggled', { enabled: enabled.toString() }).catch((err) =>
			console.error('Failed to track auto-save toggle:', err)
		);
	}

	async function handleDeviceChange(devices: SelectedDevices): Promise<void> {
		preferences = {
			...preferences,
			preferred_mic_device: devices.micDevice,
			preferred_system_device: devices.systemDevice
		};
		await savePreferences(preferences);
		Analytics.track('default_devices_changed', {
			has_preferred_microphone: (!!devices.micDevice).toString(),
			has_preferred_system_audio: (!!devices.systemDevice).toString()
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
				enabled: enabled.toString()
			});
		} catch (error) {
			console.error('Failed to save notification preference:', error);
			toast.error('Failed to save preference');
		}
	}
</script>

{#if loading}
	<div class="animate-pulse">
		<div class="mb-4 h-4 w-1/4 rounded bg-secondary"></div>
		<div class="mb-4 h-8 rounded bg-secondary"></div>
	</div>
{:else}
	<div class="space-y-6">
		<div>
			<h3 class="mb-4 text-lg font-semibold">Recording Settings</h3>
			<p class="mb-6 text-sm text-muted-foreground">
				Configure how your audio recordings are saved during meetings.
			</p>
		</div>

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Save Audio Recordings</div>
				<div class="text-sm text-muted-foreground">
					Automatically save audio files when recording stops
				</div>
			</div>
			<Switch checked={preferences.auto_save} disabled={saving} onCheckedChange={handleAutoSaveToggle} />
		</div>

		{#if preferences.auto_save}
			<div class="space-y-4">
				<div class="rounded-lg border border-border bg-secondary/40 p-4">
					<div class="mb-2 font-medium">Save Location</div>
					<div class="mb-3 break-all text-sm text-muted-foreground">
						{preferences.save_folder || 'Default folder'}
					</div>
					<button
						onclick={handleOpenFolder}
						class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-secondary"
					>
						<FolderOpen class="size-4" /> Open Folder
					</button>
				</div>

				<div class="rounded-lg border border-accent/20 bg-accent/5 p-4">
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
			<div class="rounded-lg border border-amber-500/30 bg-amber-50 p-4">
				<div class="text-sm text-amber-800">
					Audio recording is disabled. Enable "Save Audio Recordings" to automatically save your
					meeting audio.
				</div>
			</div>
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
					Start or stop a recording with Cmd/Ctrl+Shift+R from any app.
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

		<div class="space-y-4">
			<div class="border-t border-border pt-6">
				<h4 class="mb-4 text-base font-medium">Default Audio Devices</h4>
				<p class="mb-4 text-sm text-muted-foreground">
					Set your preferred microphone and system audio devices for recording. These will be
					automatically selected when starting new recordings.
				</p>

				<div class="rounded-lg border border-border bg-secondary/40 p-4">
					<DeviceSelection
						selectedDevices={{
							micDevice: preferences.preferred_mic_device,
							systemDevice: preferences.preferred_system_device
						}}
						onDeviceChange={handleDeviceChange}
						disabled={saving}
					/>
				</div>
			</div>
		</div>
	</div>
{/if}
