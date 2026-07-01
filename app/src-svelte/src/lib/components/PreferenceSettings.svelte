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
	import { Switch } from '$lib/components/ui/switch';
	import AnalyticsConsentSwitch from './AnalyticsConsentSwitch.svelte';

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

	async function handleOpenRecordingsFolder(): Promise<void> {
		try {
			await invoke('open_recordings_folder');
			await Analytics.track('storage_folder_opened', { folder_type: 'recordings' });
		} catch (error) {
			console.error('Failed to open recordings folder:', error);
		}
	}
</script>

{#if config.isLoadingPreferences && !config.notificationSettings && !config.storageLocations}
	<div class="mx-auto max-w-2xl p-6">Loading Preferences...</div>
{:else}
	<div class="flex flex-col gap-6">
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

				<div class="rounded-md bg-accent/5 p-3">
					<p class="text-xs text-foreground">
						<strong>Note:</strong> Database and models are stored together in your application data directory
						for unified management.
					</p>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Content>
				<AnalyticsConsentSwitch />
			</Card.Content>
		</Card.Root>
	</div>
{/if}
