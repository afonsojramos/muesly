<script lang="ts">
	import { onMount } from 'svelte';

	import { commands, type DictationCleanupPreset } from '$lib/bindings';
	import { toast } from '$lib/toast';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';

	let enabled = $state(false);
	let presets = $state<DictationCleanupPreset[]>([]);

	const activePresetId = $derived(presets.find((p) => p.is_active)?.id ?? '');

	onMount(() => {
		void load();
	});

	async function load(): Promise<void> {
		const e = await commands.getDictationCleanupEnabled();
		if (e.status === 'ok') enabled = e.data;
		const p = await commands.listDictationCleanupPresets();
		if (p.status === 'ok') presets = p.data;
	}

	async function toggle(value: boolean): Promise<void> {
		enabled = value;
		const res = await commands.setDictationCleanupEnabled(value);
		if (res.status === 'error') {
			enabled = !value;
			toast.error('Failed to update cleanup', { description: res.error });
		}
	}

	async function setActive(id: string): Promise<void> {
		const res = await commands.setActiveDictationCleanupPreset(id);
		if (res.status === 'error') {
			toast.error('Failed to select preset', { description: res.error });
			return;
		}
		await load();
	}

	async function save(preset: DictationCleanupPreset): Promise<void> {
		const res = await commands.updateDictationCleanupPreset(preset.id, preset.name, preset.prompt);
		if (res.status === 'error') toast.error('Failed to save preset', { description: res.error });
		else toast.info('Preset saved', { duration: 2000 });
	}

	async function create(): Promise<void> {
		const res = await commands.createDictationCleanupPreset(
			'New preset',
			'Fix grammar, punctuation, and capitalization. Output only the corrected text.'
		);
		if (res.status === 'error') {
			toast.error('Failed to create preset', { description: res.error });
			return;
		}
		await load();
	}

	async function remove(id: string): Promise<void> {
		const res = await commands.deleteDictationCleanupPreset(id);
		if (res.status === 'error') {
			toast.error('Failed to delete preset', { description: res.error });
			return;
		}
		await load();
	}
</script>

<div class="flex items-center justify-between rounded-lg border border-border p-4">
	<div class="flex-1">
		<div class="font-medium">Clean up dictated text</div>
		<div class="text-sm text-muted-foreground">
			Rewrite dictation with the local AI before inserting it. Best-effort; falls back to the raw
			text if the model isn't ready or is too slow.
		</div>
	</div>
	<Switch checked={enabled} onCheckedChange={toggle} />
</div>

{#if enabled}
	<div class="flex flex-col gap-3 rounded-lg border border-border p-4">
		<div class="flex items-center justify-between">
			<div class="font-medium">Cleanup presets</div>
			<Button variant="outline" size="sm" onclick={create}>New preset</Button>
		</div>
		<RadioGroup.Root value={activePresetId} onValueChange={setActive} class="gap-3">
			{#each presets as preset (preset.id)}
				<div class="flex flex-col gap-2 rounded-md border border-border p-3">
					<div class="flex items-center gap-2">
						<RadioGroup.Item value={preset.id} aria-label={`Use ${preset.name}`} />
						<Input bind:value={preset.name} class="flex-1" />
						<Button variant="ghost" size="sm" onclick={() => remove(preset.id)}>Delete</Button>
					</div>
					<Textarea bind:value={preset.prompt} rows={3} />
					<div class="flex justify-end">
						<Button variant="outline" size="sm" onclick={() => save(preset)}>Save</Button>
					</div>
				</div>
			{/each}
		</RadioGroup.Root>
	</div>
{/if}
