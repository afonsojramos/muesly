<script lang="ts">
	import { onMount } from 'svelte';
	import { Plus, X } from '@lucide/svelte';

	import type { TranscriptModelProps } from '$lib/services/config';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import * as Accordion from '$lib/components/ui/accordion';
	import * as Field from '$lib/components/ui/field';
	import { Badge } from '$lib/components/ui/badge';
	import IconButton from '$lib/components/IconButton.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import WhisperModelManager from './WhisperModelManager.svelte';
	import { config } from '$lib/stores/config.svelte';
	import { commands } from '$lib/bindings';
	import { Switch } from '$lib/components/ui/switch';
	import { toast } from '$lib/toast';

	interface Props {
		transcriptModelConfig: TranscriptModelProps;
		setTranscriptModelConfig: (config: TranscriptModelProps) => void;
		onModelSelect?: () => void;
	}

	let { transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: Props = $props();
	let newVocabularyTerm = $state('');

	// Post-meeting quality pass: batch re-transcription of the saved audio.
	let qualityPassEnabled = $state(false);
	onMount(() => {
		void (async () => {
			const res = await commands.getPostMeetingQualityPassEnabled();
			if (res.status === 'ok') qualityPassEnabled = res.data;
		})();
	});
	async function toggleQualityPass(enabled: boolean): Promise<void> {
		qualityPassEnabled = enabled;
		const res = await commands.setPostMeetingQualityPassEnabled(enabled);
		if (res.status === 'error') {
			qualityPassEnabled = !enabled;
			toast.error('Failed to update quality pass setting', { description: res.error });
		}
	}

	function handleWhisperSelect(
		modelName: string,
		provider?: 'automatic' | 'localWhisper' | 'parakeet',
	): void {
		setTranscriptModelConfig({
			...transcriptModelConfig,
			provider: provider ?? 'localWhisper',
			model: modelName,
		});
		onModelSelect?.();
	}

	function addVocabularyTerm(): void {
		const term = newVocabularyTerm.trim();
		if (!term) return;
		if (
			config.customVocabulary.some(
				(entry) => entry.to.toLocaleLowerCase() === term.toLocaleLowerCase(),
			)
		) {
			toast.info('That term is already in your dictionary');
			return;
		}
		config.setCustomVocabulary([
			...config.customVocabulary,
			{ from: '', to: term, learned_aliases: [] },
		]);
		config.flushCustomVocabulary();
		newVocabularyTerm = '';
	}
</script>

<div class="flex flex-col gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-balance">Transcription quality</Card.Title>
			<Card.Description>
				Speech stays on your device. Muesly recommends the best profile for this computer.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<WhisperModelManager
				selectedModel={transcriptModelConfig.model}
				onModelSelect={handleWhisperSelect}
				autoSave={true}
			/>
			{#if transcriptModelConfig.provider === 'parakeet'}
				<Alert.Root class="mt-4">
					<Alert.Title>Fastest profile trade-offs</Alert.Title>
					<Alert.Description>
						<p>
							Parakeet is optimized for very fast captions across 25 European languages. It
							auto-detects the language and cannot translate to English or use your custom
							dictionary.
						</p>
						{#if qualityPassEnabled}
							<p>
								The post-meeting quality pass is on, so finished meetings are re-transcribed with
								Whisper automatically.
							</p>
						{:else}
							<div class="flex flex-wrap items-center gap-2">
								<span>
									Enable the post-meeting quality pass to re-run finished meetings with Whisper's
									language controls and custom dictionary.
								</span>
								<Button size="xs" variant="outline" onclick={() => void toggleQualityPass(true)}>
									Enable quality pass
								</Button>
							</div>
						{/if}
					</Alert.Description>
				</Alert.Root>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<div class="flex items-start justify-between gap-4">
				<div>
					<Card.Title class="text-balance">Custom dictionary</Card.Title>
					<Card.Description>
						Teach Muesly the names, products, and technical terms you use. Everything stays on your
						device.
					</Card.Description>
				</div>
				{#if config.customVocabulary.length > 0}
					<Badge variant="secondary" class="shrink-0 tabular-nums">
						{config.customVocabulary.length}
						{config.customVocabulary.length === 1 ? 'term' : 'terms'}
					</Badge>
				{/if}
			</div>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2 sm:flex-row">
					<Field.Field class="flex-1">
						<Field.FieldLabel for="new-vocabulary-term">Add a preferred spelling</Field.FieldLabel>
						<Input
							id="new-vocabulary-term"
							bind:value={newVocabularyTerm}
							placeholder="e.g. Kubernetes, Amélie, Muesly"
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									addVocabularyTerm();
								}
							}}
						/>
					</Field.Field>
					<Button
						class="h-10 self-end transition-transform active:scale-[0.96]"
						disabled={!newVocabularyTerm.trim()}
						onclick={addVocabularyTerm}
					>
						<Plus data-icon="inline-start" /> Add term
					</Button>
				</div>

				{#if config.customVocabulary.length === 0}
					<div class="rounded-lg bg-muted/35 px-4 py-6 text-center">
						<p class="font-medium">Your dictionary is empty</p>
						<p class="mt-1 text-pretty text-sm text-muted-foreground">
							Add a term above to improve future transcriptions immediately.
						</p>
					</div>
				{/if}
				{#each config.customVocabulary as entry, i}
					<div class="rounded-lg bg-muted/35 p-3">
						<div class="grid grid-cols-[minmax(0,1fr)_2.5rem] items-end gap-2">
							<Field.Field>
								<Field.FieldLabel for={`vocabulary-term-${i}`}>Preferred spelling</Field.FieldLabel>
								<Input
									id={`vocabulary-term-${i}`}
									value={entry.to}
									oninput={(e) => {
										const preferred = e.currentTarget.value;
										const updated = config.customVocabulary.map((v, idx) =>
											idx === i
												? {
														...v,
														to: preferred,
														learned_aliases: preferred === v.to ? v.learned_aliases : [],
													}
												: v,
										);
										config.setCustomVocabulary(updated);
									}}
									onblur={config.flushCustomVocabulary}
								/>
							</Field.Field>
							<IconButton
								label={`Remove ${entry.to.trim() || 'empty preferred term'}`}
								size="icon"
								class="h-10 w-10 text-muted-foreground transition-transform active:scale-[0.96] hover:text-destructive"
								onclick={() => {
									const updated = config.customVocabulary.filter((_, idx) => idx !== i);
									config.setCustomVocabulary(updated);
								}}
							>
								<X data-icon />
							</IconButton>
						</div>

						<Accordion.Root type="single" class="mt-2">
							<Accordion.Item value={`corrections-${i}`}>
								<Accordion.Trigger class="py-2 text-sm">
									Corrections and learning
									{#if (entry.learned_aliases?.length ?? 0) > 0}
										<Badge variant="secondary" class="ml-2 tabular-nums">
											{entry.learned_aliases?.length}
										</Badge>
									{/if}
								</Accordion.Trigger>
								<Accordion.Content>
									<div class="flex flex-col gap-3 pt-2">
										<p class="text-pretty text-sm text-muted-foreground">
											Add phrases Muesly should always replace with this spelling. Otherwise, it
											learns recurring mishearings locally after seeing them twice.
										</p>
										<Field.Field>
											<Field.FieldLabel for={`vocabulary-aliases-${i}`}>
												Always replace
											</Field.FieldLabel>
											<Input
												id={`vocabulary-aliases-${i}`}
												value={entry.from}
												placeholder="cubernetes, cooper netties"
												oninput={(e) => {
													const updated = config.customVocabulary.map((v, idx) =>
														idx === i ? { ...v, from: e.currentTarget.value } : v,
													);
													config.setCustomVocabulary(updated);
												}}
												onblur={config.flushCustomVocabulary}
											/>
											<Field.FieldDescription>
												Separate multiple phrases with commas. Leave empty to learn automatically.
											</Field.FieldDescription>
										</Field.Field>

										{#if (entry.learned_aliases?.length ?? 0) > 0}
											<div class="flex flex-col gap-2">
												<p class="text-xs font-medium text-muted-foreground">Learned locally</p>
												{#each entry.learned_aliases ?? [] as learned}
													<div
														class="flex min-h-10 items-center justify-between gap-3 rounded-md bg-background px-3 py-1.5"
													>
														<span class="min-w-0 truncate text-sm">{learned.from}</span>
														<div class="flex shrink-0 items-center gap-2">
															<Badge variant={learned.observations >= 2 ? 'default' : 'secondary'}>
																<span class="tabular-nums">
																	{learned.observations >= 2
																		? 'Active'
																		: `${learned.observations}/2 learning`}
																</span>
															</Badge>
															<IconButton
																label={`Remove learned correction ${learned.from}`}
																size="icon"
																class="h-10 w-10 text-muted-foreground transition-transform active:scale-[0.96] hover:text-destructive"
																onclick={() => {
																	void config.removeLearnedVocabularyAlias(entry.to, learned.from);
																}}
															>
																<X data-icon />
															</IconButton>
														</div>
													</div>
												{/each}
											</div>
										{/if}
										{#if !entry.from.trim() && (entry.learned_aliases?.length ?? 0) === 0}
											<p class="text-pretty text-xs text-muted-foreground">
												No corrections yet. Learned variants will appear here automatically.
											</p>
										{/if}
									</div>
								</Accordion.Content>
							</Accordion.Item>
						</Accordion.Root>
					</div>
				{/each}
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header class="flex-col gap-4 space-y-0 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<Card.Title id="quality-pass-label">Post-meeting quality pass</Card.Title>
				<Card.Description>
					After each meeting, re-transcribe the full recording with merged context for higher
					accuracy while preserving microphone/system attribution from the live timeline. Local
					models only; adds processing time after the recording stops. Off by default.
				</Card.Description>
			</div>
			<Switch
				checked={qualityPassEnabled}
				aria-labelledby="quality-pass-label"
				onCheckedChange={toggleQualityPass}
			/>
		</Card.Header>
	</Card.Root>
</div>
