<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { FolderOpen } from '@lucide/svelte';
	import { onMount } from 'svelte';

	import { Monitor, Moon, Sun } from '@lucide/svelte';

	import { Analytics } from '$lib/analytics';
	import { track } from '$lib/analytics-events';
	import { config } from '$lib/stores/config.svelte';
	import { theme, type ThemeMode } from '$lib/stores/theme.svelte';
	import Switch from '$lib/ui/switch.svelte';
	import AnalyticsConsentSwitch from './AnalyticsConsentSwitch.svelte';

	const themeOptions: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon },
		{ value: 'system', label: 'System', icon: Monitor }
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
			: true
	);

	// Track a single "preferences viewed" event once settings are available.
	$effect(() => {
		if (hasTrackedView || config.isLoadingPreferences) return;
		hasTrackedView = true;
		void Analytics.track('preferences_viewed', {
			notifications_enabled: config.notificationSettings
				? config.notificationSettings.notification_preferences.show_recording_started.toString()
				: 'false'
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
					show_recording_stopped: enabled
				}
			});
			await Analytics.track('notification_settings_changed', {
				notifications_enabled: enabled.toString()
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
	<div class="space-y-6">
		<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
			<div class="flex items-center justify-between gap-4">
				<div>
					<h3 class="mb-2 text-lg font-semibold">Appearance</h3>
					<p class="text-sm text-muted-foreground">
						Choose a light or dark theme, or follow your system setting
					</p>
				</div>
				<div class="flex flex-shrink-0 rounded-lg border border-border bg-secondary/40 p-0.5">
					{#each themeOptions as option (option.value)}
						<button
							onclick={() => handleThemeChange(option.value)}
							class={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
								theme.mode === option.value
									? 'bg-card font-medium text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							}`}
							aria-pressed={theme.mode === option.value}
						>
							<option.icon class="size-4" />
							<span>{option.label}</span>
						</button>
					{/each}
				</div>
			</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
			<div class="flex items-center justify-between">
				<div>
					<h3 class="mb-2 text-lg font-semibold">Notifications</h3>
					<p class="text-sm text-muted-foreground">
						Enable or disable notifications of start and end of meeting
					</p>
				</div>
				<Switch checked={notificationsEnabled} onCheckedChange={handleNotificationToggle} />
			</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
			<h3 class="mb-4 text-lg font-semibold">Data Storage Locations</h3>
			<p class="mb-6 text-sm text-muted-foreground">
				View and access where muesly stores your data
			</p>

			<div class="space-y-4">
				<div class="rounded-lg border border-border bg-secondary/40 p-4">
					<div class="mb-2 font-medium">Meeting Recordings</div>
					<div class="mb-3 break-all font-mono text-xs text-muted-foreground">
						{config.storageLocations?.recordings || 'Loading...'}
					</div>
					<button
						onclick={handleOpenRecordingsFolder}
						class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-secondary"
					>
						<FolderOpen class="size-4" /> Open Folder
					</button>
				</div>
			</div>

			<div class="mt-4 rounded-md bg-accent/5 p-3">
				<p class="text-xs text-foreground">
					<strong>Note:</strong> Database and models are stored together in your application data
					directory for unified management.
				</p>
			</div>
		</div>

		<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
			<AnalyticsConsentSwitch />
		</div>
	</div>
{/if}
