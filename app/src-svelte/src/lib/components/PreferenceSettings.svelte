<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { FolderOpen } from '@lucide/svelte';
	import { onMount } from 'svelte';

	import { Monitor, Moon, Sun } from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import { track } from '$lib/analytics-events';
	import { config } from '$lib/stores/config.svelte';
	import { theme, type ThemeMode } from '$lib/stores/theme.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { Button } from '$lib/components/ui/button';
	import Loadable from '$lib/components/Loadable.svelte';
	import { Switch } from '$lib/components/ui/switch';
	import { commands, type GlobalShortcutInfo } from '$lib/bindings';
	import { toast } from '$lib/toast';
	import AnalyticsConsentSwitch from './AnalyticsConsentSwitch.svelte';
	import ShortcutRecorder from './ShortcutRecorder.svelte';

	const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
		{ value: 'system', label: 'System', icon: Monitor },
	];

	function handleThemeChange(mode: ThemeMode): void {
		theme.setMode(mode);
		void track('theme_changed', { theme: mode });
	}

	let hasTrackedView = false;

	onMount(() => {
		void config.loadPreferences();
	});

	const notificationsEnabled = $derived(
		config.notificationSettings
			? config.notificationSettings.notification_preferences.show_recording_started &&
					config.notificationSettings.notification_preferences.show_recording_stopped
			: true,
	);

	// Track a single "preferences viewed" event once settings are available.
	$effect(() => {
		if (hasTrackedView || config.isLoadingPreferences) return;
		hasTrackedView = true;
		void Analytics.track('preferences_viewed', {
			notifications_enabled: config.notificationSettings
				? config.notificationSettings.notification_preferences.show_recording_started.toString()
				: 'false',
		});
	});

	async function handleNotificationToggle(enabled: boolean): Promise<void> {
		const current = config.notificationSettings;
		if (!current) return;

		try {
			await config.updateNotificationSettings({
				...current,
				notification_preferences: {
					...current.notification_preferences,
					show_recording_started: enabled,
					show_recording_stopped: enabled,
				},
			});
			await Analytics.track('notification_settings_changed', {
				notifications_enabled: enabled.toString(),
			});
		} catch (error) {
			console.error('Failed to update notification settings:', error);
		}
	}

	// Global shortcut bindings (recording toggle + push-to-talk dictation).
	let recordingShortcut = $state<GlobalShortcutInfo | null>(null);
	let dictationShortcut = $state<GlobalShortcutInfo | null>(null);

	onMount(() => {
		void (async () => {
			const [rec, dic] = await Promise.all([
				commands.getRecordingShortcut(),
				commands.getDictationShortcut(),
			]);
			if (rec.status === 'ok') recordingShortcut = rec.data;
			if (dic.status === 'ok') dictationShortcut = dic.data;
		})();
	});

	async function changeRecordingShortcut(accelerator: string | null): Promise<void> {
		const res = await commands.setRecordingShortcut(accelerator);
		if (res.status === 'ok') recordingShortcut = res.data;
		else toast.error('Could not set shortcut', { description: res.error });
	}

	async function changeDictationShortcut(accelerator: string | null): Promise<void> {
		const res = await commands.setDictationShortcut(accelerator);
		if (res.status === 'ok') dictationShortcut = res.data;
		else toast.error('Could not set shortcut', { description: res.error });
	}

	async function handleOpenRecordingsFolder(): Promise<void> {
		try {
			await invoke('open_recordings_folder');
			await Analytics.track('storage_folder_opened', { folder_type: 'recordings' });
		} catch (error) {
			console.error('Failed to open recordings folder:', error);
		}
	}
</script>

<div class="flex flex-col gap-6">
	<Loadable loading={config.isLoadingPreferences}>
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between gap-4">
					<div>
						<Card.Title>Appearance</Card.Title>
						<Card.Description>
							Choose a light or dark theme, or follow your system setting
						</Card.Description>
					</div>
					<ToggleGroup.Root
						type="single"
						value={theme.mode}
						onValueChange={(value) => {
							if (value) handleThemeChange(value as ThemeMode);
						}}
						variant="outline"
						aria-label="Theme"
					>
						{#each themeOptions as option (option.value)}
							{@const Icon = option.icon}
							<ToggleGroup.Item value={option.value} aria-label={option.label}>
								<Icon data-icon="inline-start" />
								{option.label}
							</ToggleGroup.Item>
						{/each}
					</ToggleGroup.Root>
				</div>
			</Card.Header>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div>
						<Card.Title>Notifications</Card.Title>
						<Card.Description>
							Enable or disable notifications of start and end of meeting
						</Card.Description>
					</div>
					<Switch checked={notificationsEnabled} onCheckedChange={handleNotificationToggle} />
				</div>
			</Card.Header>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Keyboard shortcuts</Card.Title>
				<Card.Description>
					System-wide shortcuts. Click a shortcut, then press the new key combination.
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-1">
				<div class="flex items-center justify-between gap-4 py-1.5">
					<div>
						<div class="text-sm font-medium">Start or stop recording</div>
						<div class="text-sm text-muted-foreground">
							Works from any app while the global shortcut is enabled in Recordings.
						</div>
					</div>
					{#if recordingShortcut}
						<ShortcutRecorder info={recordingShortcut} onChange={changeRecordingShortcut} />
					{/if}
				</div>
				<div class="flex items-center justify-between gap-4 py-1.5">
					<div>
						<div class="text-sm font-medium">Push-to-talk dictation</div>
						<div class="text-sm text-muted-foreground">
							Hold to dictate, release to transcribe, while dictation is enabled in Recordings.
						</div>
					</div>
					{#if dictationShortcut}
						<ShortcutRecorder info={dictationShortcut} onChange={changeDictationShortcut} />
					{/if}
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Data Storage Locations</Card.Title>
				<Card.Description>View and access where muesly stores your data</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div class="rounded-lg border border-border bg-secondary/40 p-4">
					<div class="mb-2 font-medium">Meeting Recordings</div>
					<div class="mb-3 break-all font-mono text-xs text-muted-foreground">
						{config.storageLocations?.recordings || 'Loading...'}
					</div>
					<Button variant="outline" size="sm" onclick={handleOpenRecordingsFolder}>
						<FolderOpen data-icon="inline-start" /> Open Folder
					</Button>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Content>
				<AnalyticsConsentSwitch />
			</Card.Content>
		</Card.Root>
	</Loadable>
</div>
