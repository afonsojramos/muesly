<script lang="ts">
	import { onMount } from 'svelte';
	import { Calendar, ExternalLink, ShieldAlert, Trash2 } from '@lucide/svelte';

	import Switch from '$lib/ui/switch.svelte';
	import Alert from '$lib/ui/alert.svelte';
	import { toast } from '$lib/toast';
	import {
		commands,
		type CalendarAccount,
		type CalendarAuthStatus,
		type CalendarInfo
	} from '$lib/bindings';

	let loading = $state(true);
	let authStatus = $state<CalendarAuthStatus>('notdetermined');
	let enabled = $state(false);
	let calendars = $state<CalendarInfo[]>([]);
	let excludedIds = $state<Set<string>>(new Set());
	let sendNames = $state(false);
	let sendNotes = $state(false);
	let requesting = $state(false);
	let accounts = $state<CalendarAccount[]>([]);
	let googleConfigured = $state(false);
	// Monotonic id so only the most recent "Add account" click is applied; an
	// earlier attempt the user abandoned (closed the tab) resolves later and is
	// ignored rather than overwriting the result of the click they completed.
	let addAttempt = 0;

	const granted = $derived(authStatus === 'granted');
	const googleAccounts = $derived(accounts.filter((a) => a.source === 'google'));

	async function loadAccounts(): Promise<void> {
		const list = await commands.calendarListAccounts();
		if (list.status === 'ok') accounts = list.data;
		googleConfigured = await commands.calendarGoogleConfigured();
	}

	async function addGoogleAccount(): Promise<void> {
		const attempt = ++addAttempt;
		const res = await commands.calendarAddGoogleAccount();
		// A newer click superseded this one (e.g. the user re-clicked after
		// closing the first tab); ignore this stale result entirely.
		if (attempt !== addAttempt) return;
		if (res.status === 'ok') {
			toast.success(`Connected ${res.data.email ?? 'Google account'}.`);
			await loadAccounts();
		} else {
			toast.error('Could not connect Google account', { description: res.error });
		}
	}

	async function removeAccount(id: string): Promise<void> {
		const res = await commands.calendarRemoveAccount(id);
		if (res.status === 'ok') await loadAccounts();
		else toast.error('Could not remove account', { description: res.error });
	}

	async function toggleAccount(id: string, next: boolean): Promise<void> {
		const res = await commands.calendarSetAccountEnabled(id, next);
		if (res.status === 'error') {
			toast.error('Could not update source', { description: res.error });
		}
		await loadAccounts();
	}

	async function loadCalendars(): Promise<void> {
		const list = await commands.calendarListCalendars();
		if (list.status === 'ok') calendars = list.data;
		const ex = await commands.calendarGetExcludedIds();
		if (ex.status === 'ok') excludedIds = new Set(ex.data);
	}

	onMount(() => {
		void (async () => {
			try {
				authStatus = await commands.calendarPermissionStatus();
				const en = await commands.calendarGetContextEnabled();
				if (en.status === 'ok') enabled = en.data;
				const names = await commands.calendarGetSendAttendeeNamesToCloud();
				if (names.status === 'ok') sendNames = names.data;
				const notes = await commands.calendarGetSendNotesToCloud();
				if (notes.status === 'ok') sendNotes = notes.data;
				await loadAccounts();
				if (granted) await loadCalendars();
			} finally {
				loading = false;
			}
		})();
	});

	async function handleEnableToggle(next: boolean): Promise<void> {
		// Turning on without permission: request it first.
		if (next && !granted) {
			requesting = true;
			try {
				authStatus = await commands.calendarRequestAccess().then((r) =>
					r.status === 'ok' ? r.data : authStatus
				);
			} finally {
				requesting = false;
			}
			if (!granted) {
				toast.error('Calendar access not granted', {
					description: 'muesly needs read access to your calendar to add meeting context.'
				});
				return;
			}
			await loadCalendars();
		}

		enabled = next;
		const res = await commands.calendarSetContextEnabled(next);
		if (res.status === 'error') {
			enabled = !next;
			toast.error('Failed to update calendar setting', { description: res.error });
		}
	}

	async function requestAccess(): Promise<void> {
		requesting = true;
		try {
			const r = await commands.calendarRequestAccess();
			if (r.status === 'ok') authStatus = r.data;
			if (granted) await loadCalendars();
		} finally {
			requesting = false;
		}
	}

	async function openSettings(): Promise<void> {
		await commands.calendarOpenSettings();
	}

	async function toggleCalendar(id: string, include: boolean): Promise<void> {
		const next = new Set(excludedIds);
		if (include) next.delete(id);
		else next.add(id);
		excludedIds = next;
		const res = await commands.calendarSetExcludedIds([...next]);
		if (res.status === 'error') {
			toast.error('Failed to update calendar selection', { description: res.error });
		}
	}

	async function toggleSendNames(next: boolean): Promise<void> {
		sendNames = next;
		const res = await commands.calendarSetSendAttendeeNamesToCloud(next);
		if (res.status === 'error') {
			sendNames = !next;
			toast.error('Failed to update setting', { description: res.error });
		}
	}

	async function toggleSendNotes(next: boolean): Promise<void> {
		sendNotes = next;
		const res = await commands.calendarSetSendNotesToCloud(next);
		if (res.status === 'error') {
			sendNotes = !next;
			toast.error('Failed to update setting', { description: res.error });
		}
	}

	async function purgeData(): Promise<void> {
		const res = await commands.calendarPurgeAllSnapshots();
		if (res.status === 'ok') {
			toast.success(`Deleted calendar data from ${res.data} recording(s).`);
		} else {
			toast.error('Failed to delete calendar data', { description: res.error });
		}
	}
</script>

{#if loading}
	<div class="animate-pulse">
		<div class="mb-4 h-8 rounded bg-secondary"></div>
		<div class="mb-4 h-8 rounded bg-secondary"></div>
	</div>
{:else}
	<div class="space-y-6">
		<div>
			<h3 class="mb-4 text-lg font-semibold">Calendar</h3>
			<p class="mb-6 text-sm text-muted-foreground">
				muesly attaches the meeting happening at record time to your recordings and summaries. Use
				your Mac's local calendars (read entirely on-device, no account) and/or connect Google
				accounts (read-only). Everything is off by default; what reaches a cloud summary provider is
				controlled separately below.
			</p>
		</div>

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Use calendar context</div>
				<div class="text-sm text-muted-foreground">
					Match each recording to the meeting happening at that time.
				</div>
			</div>
			<Switch checked={enabled} disabled={requesting} onCheckedChange={handleEnableToggle} />
		</div>

		{#if enabled}
			<div class="rounded-lg border border-border p-4">
				<div class="mb-1 font-medium">Calendar sources</div>
				<div class="mb-3 text-sm text-muted-foreground">
					Enable one or more sources. Events from all enabled sources are matched to your
					recordings.
				</div>
				<div class="space-y-2">
					<!-- Local macOS source -->
					<div class="flex items-center justify-between">
						<div class="text-sm">
							On this Mac
							{#if !granted}
								<span class="ml-2 text-xs text-amber-600">(calendar access needed)</span>
							{/if}
						</div>
						{#each accounts.filter((a) => a.source === 'eventkit') as local (local.id)}
							<Switch
								checked={local.enabled}
								onCheckedChange={(v) => toggleAccount(local.id, v)}
							/>
						{/each}
					</div>

					<!-- Connected Google accounts -->
					{#each googleAccounts as acct (acct.id)}
						<div class="flex items-center justify-between">
							<div class="text-sm">
								{acct.email ?? 'Google account'}
								{#if acct.status === 'reauth_required'}
									<span class="ml-2 text-xs text-amber-600">(reconnect needed - remove &amp; re-add)</span>
								{/if}
							</div>
							<div class="flex items-center gap-3">
								<Switch checked={acct.enabled} onCheckedChange={(v) => toggleAccount(acct.id, v)} />
								<button
									onclick={() => removeAccount(acct.id)}
									class="text-xs text-muted-foreground transition-colors hover:text-destructive"
									aria-label="Remove account"
								>
									Remove
								</button>
							</div>
						</div>
					{/each}
				</div>

				<div class="mt-4">
					{#if googleConfigured}
						<button
							onclick={addGoogleAccount}
							class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-secondary"
						>
							<Calendar class="size-4" />
							Add Google account
						</button>
						<p class="mt-2 text-xs text-muted-foreground">
							Read-only. Opens your browser; nothing is routed through a muesly server. While in
							review, you may need to reconnect about weekly.
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">
							Google accounts are unavailable: no OAuth client id is configured (set
							<code>MUESLY_GOOGLE_CLIENT_ID</code> / <code>MUESLY_GOOGLE_CLIENT_SECRET</code>).
						</p>
					{/if}
				</div>
			</div>
		{/if}

		{#if enabled && !granted}
			<Alert variant="warning">
				{#snippet icon()}<ShieldAlert class="size-4" />{/snippet}
				{#snippet title()}Calendar access required{/snippet}
				{#if authStatus === 'restricted'}
					<p>Calendar access is restricted by your device management and cannot be granted here.</p>
				{:else if authStatus === 'denied' || authStatus === 'writeonly'}
					<p class="mb-2">
						muesly needs read access to your calendar. Grant full access in System Settings.
					</p>
					<button
						onclick={openSettings}
						class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-secondary"
					>
						<ExternalLink class="size-4" /> Open System Settings
					</button>
				{:else}
					<p class="mb-2">muesly needs read access to your calendar.</p>
					<button
						onclick={requestAccess}
						disabled={requesting}
						class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-secondary disabled:opacity-50"
					>
						<Calendar class="size-4" /> Grant calendar access
					</button>
				{/if}
			</Alert>
		{/if}

		{#if enabled && granted}
			<div class="rounded-lg border border-border p-4">
				<div class="mb-1 font-medium">Calendars</div>
				<div class="mb-3 text-sm text-muted-foreground">
					Choose which calendars are used to match meetings. Holiday and subscribed calendars are
					excluded automatically.
				</div>
				{#if calendars.length === 0}
					<div class="text-sm text-muted-foreground">
						No calendars found. Add an account in the macOS Calendar app.
					</div>
				{:else}
					<div class="space-y-2">
						{#each calendars as cal (cal.id)}
							<div class="flex items-center justify-between">
								<div class="text-sm">
									{cal.title}
									{#if cal.excluded_by_default}
										<span class="ml-2 text-xs text-muted-foreground">(excluded by default)</span>
									{/if}
								</div>
								<Switch
									checked={!cal.excluded_by_default && !excludedIds.has(cal.id)}
									disabled={cal.excluded_by_default}
									onCheckedChange={(v) => toggleCalendar(cal.id, v)}
								/>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="rounded-lg border border-border p-4">
				<div class="mb-1 font-medium">Cloud summaries</div>
				<div class="mb-3 text-sm text-muted-foreground">
					When you use a cloud summary provider, these control what calendar data may leave your
					device. Attendee emails are never sent or stored.
				</div>
				<Alert variant="warning" class="mb-4">
					{#snippet icon()}<ShieldAlert class="size-4" />{/snippet}
					<p>
						With a cloud provider selected, anything enabled below is sent to that provider when a
						summary is generated. Local summaries always include full context and send nothing.
					</p>
				</Alert>
				<div class="flex items-center justify-between py-2">
					<div class="text-sm">Send attendee &amp; organizer names</div>
					<Switch checked={sendNames} onCheckedChange={toggleSendNames} />
				</div>
				<div class="flex items-center justify-between py-2">
					<div class="text-sm">Send agenda / notes</div>
					<Switch checked={sendNotes} onCheckedChange={toggleSendNotes} />
				</div>
			</div>
		{/if}

		<div class="flex items-center justify-between rounded-lg border border-border p-4">
			<div class="flex-1">
				<div class="font-medium">Delete stored calendar data</div>
				<div class="text-sm text-muted-foreground">
					Remove every calendar snapshot saved with your recordings, keeping the recordings.
				</div>
			</div>
			<button
				onclick={purgeData}
				class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-secondary"
			>
				<Trash2 class="size-4" /> Delete
			</button>
		</div>
	</div>
{/if}
