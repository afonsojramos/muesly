<script lang="ts">
	import { AlertCircle, FlaskConical } from '@lucide/svelte';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Switch } from '$lib/components/ui/switch';
	import { config } from '$lib/stores/config.svelte';
	import {
		BETA_FEATURE_NAMES,
		BETA_FEATURE_DESCRIPTIONS,
		type BetaFeatureKey
	} from '$lib/beta-features';

	const featureOrder: BetaFeatureKey[] = ['importAndRetranscribe'];
</script>

<div class="flex flex-col gap-6">
	<Alert.Root class="border-warning/30 text-warning">
		<AlertCircle />
		<Alert.Title>Beta Features</Alert.Title>
		<Alert.Description class="text-warning/90">
			These features are still being tested. You may encounter issues, and we appreciate your
			feedback.
		</Alert.Description>
	</Alert.Root>

	{#each featureOrder as featureKey (featureKey)}
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div class="flex-1">
						<div class="mb-2 flex items-center gap-2">
							<FlaskConical class="size-5 text-muted-foreground" />
							<Card.Title>{BETA_FEATURE_NAMES[featureKey]}</Card.Title>
							<Badge variant="secondary">BETA</Badge>
						</div>
						<Card.Description>{BETA_FEATURE_DESCRIPTIONS[featureKey]}</Card.Description>
					</div>
					<div class="ml-6">
						<Switch
							checked={config.betaFeatures[featureKey]}
							onCheckedChange={(checked) => config.toggleBetaFeature(featureKey, checked)}
						/>
					</div>
				</div>
			</Card.Header>
		</Card.Root>
	{/each}

	<Alert.Root class="border-accent/20">
		<Alert.Description>
			<strong>Note:</strong> When disabled, beta features will be hidden. Your existing meetings remain
			unaffected.
		</Alert.Description>
	</Alert.Root>
</div>
