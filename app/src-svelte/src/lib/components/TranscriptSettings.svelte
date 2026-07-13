<script lang="ts">
	import { onMount } from 'svelte';
	import { Plus, X } from '@lucide/svelte';

	import type { TranscriptModelProps } from '$lib/services/config';
	import * as Card from '$lib/components/ui/card';
	import * as Accordion from '$lib/components/ui/accordion';
	import * as Field from '$lib/components/ui/field';
	import { Badge } from '$lib/components/ui/badge';
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
	const hasLearnedCorrections = $derived(
		config.customVocabulary.some((entry) => (entry.learned_aliases?.length ?? 0) > 0),
	);

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

	function handleWhisperSelect(modelName: string): void {
		setTranscriptModelConfig({
			...transcriptModelConfig,
			provider: 'localWhisper',
			model: modelName,
		});
		onModelSelect?.();
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
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-balance">Custom dictionary</Card.Title>
			<Card.Description>
				Add the spelling you want. Muesly uses it as context and privately learns recurring
				mishearings from your recordings.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-col gap-3">
				{#if config.customVocabulary.length === 0}
					<p class="text-pretty rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
						No preferred terms yet. Add the words that matter in your meetings.
					</p>
				{/if}
				{#each config.customVocabulary as entry, i}
					<div class="grid grid-cols-[minmax(0,1fr)_2.5rem] items-end gap-3">
						<Field.Field>
							<Field.FieldLabel for={`vocabulary-term-${i}`}>Preferred term</Field.FieldLabel>
							<Input
								id={`vocabulary-term-${i}`}
								value={entry.to}
								placeholder="Kubernetes"
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
						<Button
							variant="ghost"
							size="icon"
							class="h-10 w-10 text-muted-foreground transition-transform active:scale-[0.96] hover:text-destructive"
							aria-label={`Remove ${entry.to.trim() || 'empty preferred term'}`}
							onclick={() => {
								const updated = config.customVocabulary.filter((_, idx) => idx !== i);
								config.setCustomVocabulary(updated);
							}}
						>
							<X data-icon />
						</Button>
					</div>
				{/each}
				<Button
					variant="outline"
					size="sm"
					class="h-10 self-start transition-transform active:scale-[0.96]"
					onclick={() => {
						config.setCustomVocabulary([
							...config.customVocabulary,
							{ from: '', to: '', learned_aliases: [] },
						]);
					}}
				>
					<Plus data-icon="inline-start" />
					Add term
				</Button>

				{#if config.customVocabulary.length > 0}
					<Accordion.Root type="single" class="pt-1">
						<Accordion.Item value="advanced-corrections">
							<Accordion.Trigger>Advanced corrections</Accordion.Trigger>
							<Accordion.Content>
								<div class="flex flex-col gap-4 pt-3">
									<p class="text-pretty text-sm text-muted-foreground">
										Manual corrections apply to future transcription without a learning period and
										pause automatic learning for that term. Otherwise, Muesly retains one likely
										recurring mishearing after observing it in two separate recordings.
									</p>
									{#each config.customVocabulary as entry, i}
										{#if entry.to.trim()}
											<div class="flex flex-col gap-3 rounded-lg bg-muted/40 p-3">
												<p class="font-medium">{entry.to}</p>
												<Field.Field>
													<Field.FieldLabel for={`vocabulary-aliases-${i}`}>
														Manual corrections <span class="font-normal text-muted-foreground"
															>(optional)</span
														>
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
														Separate multiple phrases with commas.
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
																	<Badge
																		variant={learned.observations >= 2 ? 'default' : 'secondary'}
																	>
																		<span class="tabular-nums">
																			{learned.observations >= 2
																				? 'Active'
																				: `${learned.observations}/2 learning`}
																		</span>
																	</Badge>
																	<Button
																		variant="ghost"
																		size="icon"
																		class="h-10 w-10 text-muted-foreground transition-transform active:scale-[0.96] hover:text-destructive"
																		aria-label={`Remove learned correction ${learned.from}`}
																		onclick={() => {
																			void config.removeLearnedVocabularyAlias(
																				entry.to,
																				learned.from,
																			);
																		}}
																	>
																		<X data-icon />
																	</Button>
																</div>
															</div>
														{/each}
													</div>
												{/if}
											</div>
										{/if}
									{/each}
									{#if !hasLearnedCorrections}
										<p class="text-pretty text-xs text-muted-foreground">
											No learned corrections yet. They will appear here after Muesly finds a likely
											recurring mishearing.
										</p>
									{/if}
								</div>
							</Accordion.Content>
						</Accordion.Item>
					</Accordion.Root>
				{/if}
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header class="flex-row items-center justify-between gap-4 space-y-0">
			<div>
				<Card.Title>Post-meeting quality pass</Card.Title>
				<Card.Description>
					After each meeting, re-transcribe the full recording with merged context for higher
					accuracy while preserving microphone/system attribution from the live timeline. Local
					models only; adds processing time after the recording stops. Off by default.
				</Card.Description>
			</div>
			<Switch checked={qualityPassEnabled} onCheckedChange={toggleQualityPass} />
		</Card.Header>
	</Card.Root>
</div>
