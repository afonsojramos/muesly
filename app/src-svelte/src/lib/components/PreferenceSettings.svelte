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
	import { toast } from '$lib/toast';
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
	let notificationSaving = $state(false);

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

		notificationSaving = true;
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
			toast.error('Could not update notifications', {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			notificationSaving = false;
		}
	}

	async function handleOpenRecordingsFolder(): Promise<void> {
		try {
			await invoke('open_recordings_folder');
			await Analytics.track('storage_folder_opened', { folder_type: 'recordings' });
		} catch (error) {
			console.error('Failed to open recordings folder:', error);
			toast.error('Could not open the recordings folder', {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}
</script>

<div class="flex flex-col gap-4">
	<Loadable loading={config.isLoadingPreferences}>
		<Card.Root>
			<Card.Header>
				<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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
				<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<Card.Title id="system-notifications-label">System notifications</Card.Title>
						<Card.Description>
							Show a system notification when a meeting starts and ends
						</Card.Description>
					</div>
					<Switch
						checked={notificationsEnabled}
						disabled={!config.notificationSettings || notificationSaving}
						aria-labelledby="system-notifications-label"
						onCheckedChange={handleNotificationToggle}
					/>
				</div>
			</Card.Header>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Data storage locations</Card.Title>
				<Card.Description>View and access where Muesly stores your data</Card.Description>
			</Card.Header>
			<Card.Content>
				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div class="min-w-0">
						<div class="font-medium">Meeting recordings</div>
						<div class="mt-1 break-all font-mono text-xs text-muted-foreground">
							{config.storageLocations?.recordings || 'Location unavailable'}
						</div>
					</div>
					<Button class="shrink-0" variant="outline" size="sm" onclick={handleOpenRecordingsFolder}>
						<FolderOpen data-icon="inline-start" /> Open folder
					</Button>
				</div>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Privacy and analytics</Card.Title>
				<Card.Description>
					Choose whether to share anonymous product usage. Meeting content always stays private.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<AnalyticsConsentSwitch />
			</Card.Content>
		</Card.Root>
	</Loadable>
</div>
