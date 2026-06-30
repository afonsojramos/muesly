<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';

	let isLoading = $state(false);
	let consoleVisible = $state(false);

	const platform = usePlatform();
	const supported = $derived(platform.isMac || platform.isWindows);

	async function run(command: 'toggle_console' | 'show_console' | 'hide_console', next: boolean): Promise<void> {
		isLoading = true;
		try {
			await invoke(command);
			consoleVisible = next;
		} catch (error) {
			console.error(`Failed to run ${command}:`, error);
		} finally {
			isLoading = false;
		}
	}
</script>

{#if supported}
	<div class="flex flex-col gap-4">
		<div class="flex items-center justify-between">
			<Label>Developer Console</Label>
			<Switch
				checked={consoleVisible}
				disabled={isLoading}
				onCheckedChange={(checked) =>
					checked ? run('show_console', true) : run('hide_console', false)}
			/>
		</div>
		<div class="flex gap-2">
			<Button variant="outline" size="sm" disabled={isLoading} onclick={() => run('toggle_console', !consoleVisible)}>
				Toggle Console
			</Button>
		</div>
		<p class="text-sm text-muted-foreground">
			Show or hide the developer console window. On Windows, this controls the console window. On
			macOS, this opens Terminal with app logs.
		</p>
	</div>
{/if}
