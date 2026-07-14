<script lang="ts">
	import { onMount } from 'svelte';

	import { commands, type DictationCleanupPreset } from '$lib/bindings';
	import { toast } from '$lib/toast';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Settings2 } from '@lucide/svelte';

	let enabled = $state(false);
	let presets = $state<DictationCleanupPreset[]>([]);
	let editorOpen = $state(false);

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
			'Fix grammar, punctuation, and capitalization. Output only the corrected text.',
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

<div
	class="flex min-h-14 flex-col gap-3 border-t border-border/60 py-3 sm:flex-row sm:items-center sm:justify-between"
>
	<div class="min-w-0 flex-1">
		<div id="dictation-cleanup-label" class="font-medium">Clean up dictated text</div>
		<div class="text-sm text-muted-foreground">
			{enabled
				? `Using ${presets.find((preset) => preset.is_active)?.name ?? 'the active preset'}`
				: 'Optionally rewrite grammar and punctuation with local AI'}
		</div>
	</div>
	<div class="flex items-center gap-2">
		<Button variant="outline" size="sm" onclick={() => (editorOpen = true)}>
			<Settings2 data-icon="inline-start" /> Configure
		</Button>
		<Switch checked={enabled} aria-labelledby="dictation-cleanup-label" onCheckedChange={toggle} />
	</div>
</div>

<Dialog.Root bind:open={editorOpen}>
	<Dialog.Content class="flex max-h-[80vh] flex-col sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Dictation cleanup presets</Dialog.Title>
			<Dialog.Description>
				Choose how local AI should rewrite dictated text before inserting it into another app.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex items-center justify-between gap-3">
			<p class="text-sm text-muted-foreground">Select one preset as the active cleanup style.</p>
			<Button variant="outline" size="sm" onclick={create}>New preset</Button>
		</div>
		<div class="min-h-0 overflow-y-auto pr-1">
			<RadioGroup.Root value={activePresetId} onValueChange={setActive} class="gap-3">
				{#each presets as preset (preset.id)}
					<div class="flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
						<div class="flex items-center gap-2">
							<RadioGroup.Item value={preset.id} aria-label={`Use ${preset.name}`} />
							<Input bind:value={preset.name} class="flex-1" aria-label="Preset name" />
							<Button variant="ghost" size="sm" onclick={() => remove(preset.id)}>Delete</Button>
						</div>
						<Textarea bind:value={preset.prompt} rows={3} aria-label={`${preset.name} prompt`} />
						<div class="flex justify-end">
							<Button variant="outline" size="sm" onclick={() => save(preset)}>Save changes</Button>
						</div>
					</div>
				{/each}
			</RadioGroup.Root>
		</div>
	</Dialog.Content>
</Dialog.Root>
