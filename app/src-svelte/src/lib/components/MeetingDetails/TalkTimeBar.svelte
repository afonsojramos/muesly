<script lang="ts">
	import { commands, type TalkTimeGroup } from '$lib/bindings';
	import { clusterSignatureOf, type SpeakerContext } from '$lib/speaker-label';
	import { buildTalkTimeBuckets, formatSeconds } from '$lib/talk-time';
	import type { TranscriptSegmentData } from '$lib/types';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { cn } from '$lib/utils';

	interface Props {
		meetingId: string;
		/** Loaded segments — only used to detect diarization changes (cluster signature). */
		segments: TranscriptSegmentData[];
		speakerContext: SpeakerContext;
	}

	let { meetingId, segments, speakerContext }: Props = $props();

	let groups = $state<TalkTimeGroup[]>([]);
	// Monotonic token: a resolved fetch for a stale meeting/signature is dropped.
	let genId = 0;

	const clusterSignature = $derived(clusterSignatureOf(segments));

	$effect(() => {
		const id = meetingId;
		// Refresh when diarization changes the cluster set (labels re-bucket).
		void clusterSignature;
		genId += 1;
		const gen = genId;
		groups = [];
		if (!id) return;
		void commands.getTalkTime(id).then((res) => {
			if (gen !== genId || res.status !== 'ok') return;
			groups = res.data;
		});
	});

	const buckets = $derived(buildTalkTimeBuckets(groups, speakerContext));

	// One accent hue, stepped opacity: distinguishable without raw palette colors.
	// "Other participants" gets the muted tone. Beyond the ramp, reuse the tail.
	const RAMP = ['bg-accent', 'bg-accent/70', 'bg-accent/50', 'bg-accent/35', 'bg-accent/25'];
	function barClass(index: number, label: string): string {
		if (label === 'Other participants') return 'bg-muted-foreground/30';
		return RAMP[Math.min(index, RAMP.length - 1)] ?? 'bg-accent/25';
	}
</script>

{#if buckets.length >= 2}
	<div class="flex flex-col gap-1.5">
		<div class="flex h-2 w-full gap-px overflow-hidden rounded-full">
			{#each buckets as bucket, i (bucket.label)}
				<Tooltip.Provider delayDuration={200}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<div
									{...props}
									class={cn('h-full', barClass(i, bucket.label))}
									style={`width: ${(bucket.fraction * 100).toFixed(2)}%`}
									role="img"
									aria-label={`${bucket.label} spoke for ${formatSeconds(bucket.seconds)}`}
								></div>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>
							{bucket.label} · {formatSeconds(bucket.seconds)}
						</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			{/each}
		</div>
		<div class="flex flex-wrap gap-x-3 gap-y-0.5">
			{#each buckets as bucket, i (bucket.label)}
				<span class="flex items-center gap-1 text-[11px] text-muted-foreground">
					<span class={cn('size-2 rounded-full', barClass(i, bucket.label))}></span>
					<span class="font-medium text-foreground/80">{bucket.label}</span>
					{formatSeconds(bucket.seconds)} · {Math.round(bucket.fraction * 100)}%
				</span>
			{/each}
		</div>
	</div>
{/if}
