<script lang="ts">
	import type { Bar } from '$lib/bars/catalog';
	import { barVariables, fillBarVariables, variableLabel } from '$lib/bars/variables';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	interface Props {
		open: boolean;
		bar: Bar | null;
		onRun: (prompt: string) => void;
	}

	let { open = $bindable(), bar, onRun }: Props = $props();
	let values = $state<Record<string, string>>({});
	let lastBarId: string | null = null;

	const variables = $derived(bar ? barVariables(bar.prompt) : []);
	const canRun = $derived(variables.every((name) => values[name]?.trim()));

	$effect(() => {
		if (bar?.id !== lastBarId) {
			lastBarId = bar?.id ?? null;
			values = {};
		}
	});

	function run(): void {
		if (!bar || !canRun) return;
		onRun(fillBarVariables(bar.prompt, values));
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-[440px]">
		<Dialog.Header>
			<Dialog.Title>{bar?.title ?? 'Run bar'}</Dialog.Title>
			<Dialog.Description>Add the details this bar needs before it runs.</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-4 py-2">
			{#each variables as variable (variable)}
				<div class="flex flex-col gap-1.5">
					<Label for={`bar-variable-${variable}`}>{variableLabel(variable)}</Label>
					<Input
						id={`bar-variable-${variable}`}
						value={values[variable] ?? ''}
						oninput={(event) => (values = { ...values, [variable]: event.currentTarget.value })}
						placeholder={`Enter ${variable.toLowerCase()}`}
					/>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
			<Button disabled={!canRun} onclick={run}>Run bar</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
