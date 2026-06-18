<script lang="ts">
	import { AlertCircle, FlaskConical } from '@lucide/svelte';
	import Switch from '$lib/ui/switch.svelte';
	import { config } from '$lib/stores/config.svelte';
	import {
		BETA_FEATURE_NAMES,
		BETA_FEATURE_DESCRIPTIONS,
		type BetaFeatureKey
	} from '$lib/beta-features';

	const featureOrder: BetaFeatureKey[] = ['importAndRetranscribe'];
</script>

<div class="space-y-6">
	<div class="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
		<AlertCircle class="mt-0.5 size-5 shrink-0 text-amber-600" />
		<div class="text-sm text-amber-800">
			<p class="font-medium">Beta Features</p>
			<p class="mt-1">
				These features are still being tested. You may encounter issues, and we appreciate your
				feedback.
			</p>
		</div>
	</div>

	{#each featureOrder as featureKey (featureKey)}
		<div class="rounded-lg border border-border bg-card p-6 shadow-sm">
			<div class="flex items-center justify-between">
				<div class="flex-1">
					<div class="mb-2 flex items-center gap-2">
						<FlaskConical class="size-5 text-muted-foreground" />
						<h3 class="text-lg font-semibold">{BETA_FEATURE_NAMES[featureKey]}</h3>
						<span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
							BETA
						</span>
					</div>
					<p class="text-sm text-muted-foreground">{BETA_FEATURE_DESCRIPTIONS[featureKey]}</p>
				</div>
				<div class="ml-6">
					<Switch
						checked={config.betaFeatures[featureKey]}
						onCheckedChange={(checked) => config.toggleBetaFeature(featureKey, checked)}
					/>
				</div>
			</div>
		</div>
	{/each}

	<div class="rounded-lg border border-accent/20 bg-accent/5 p-4">
		<p class="text-sm">
			<strong>Note:</strong> When disabled, beta features will be hidden. Your existing meetings remain
			unaffected.
		</p>
	</div>
</div>
