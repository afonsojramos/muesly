<script lang="ts">
	import { onMount } from 'svelte';
	import { Calendar, RefreshCw, ShieldAlert, Trash2 } from '@lucide/svelte';

	import { Switch } from '$lib/components/ui/switch';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import Loadable from '$lib/components/Loadable.svelte';
	import { toast } from '$lib/toast';
	import { cn } from '$lib/utils';
	import { usePlatform } from '$lib/hooks/use-platform.svelte';
	import {
		commands,
		type CalendarAccount,
		type CalendarAuthStatus,
		type CalendarInfo,
	} from '$lib/bindings';

	let loading = $state(true);
	let authStatus = $state<CalendarAuthStatus>('notdetermined');
	let enabled = $state(false);
	let calendars = $state<CalendarInfo[]>([]);
	// False until the local (EventKit) calendar list has been fetched, so the
	// section can show a loading state instead of a premature "No calendars found".
	let localCalendarsLoaded = $state(false);
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

	// EventKit is macOS-only; other platforms hide the "On this Mac" source.
	const platform = usePlatform();
	const granted = $derived(authStatus === 'granted');
	const googleAccounts = $derived(accounts.filter((a) => a.source === 'google'));
	const localAccount = $derived(accounts.find((a) => a.source === 'eventkit') ?? null);

	async function loadAccounts(): Promise<void> {
		const list = await commands.calendarListAccounts();
		if (list.status === 'ok') accounts = list.data;
		googleConfigured = await commands.calendarGoogleConfigured();
		await loadAllAccountCalendars();
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
		// The local (EventKit) source is what needs macOS calendar permission, so
		// enabling it requests access inline (no separate "grant access" button).
		if (next && id === localAccount?.id && !granted) {
			requesting = true;
			try {
				const r = await commands.calendarRequestAccess();
				if (r.status === 'ok') authStatus = r.data;
			} finally {
				requesting = false;
			}
			if (!granted) {
				if (authStatus === 'restricted') {
					toast.error('Calendar access is restricted', {
						description:
							'Your device management settings prevent granting calendar access to muesly.',
					});
				} else {
					// macOS only shows the consent prompt once; afterwards access has to
					// be granted from System Settings.
					toast.error('Calendar access not granted', {
						description: 'Grant muesly full calendar access in System Settings, then try again.',
						action: {
							label: 'Open System Settings',
							onClick: () => {
								void commands.calendarOpenSettings();
							},
						},
					});
				}
				return;
			}
			void loadCalendars();
		}
		const res = await commands.calendarSetAccountEnabled(id, next);
		if (res.status === 'error') {
			toast.error('Could not update source', { description: res.error });
		}
		await loadAccounts();
	}

	// Per-account calendar selection. Every Google account's calendars are always
	// shown; `accountCalendars[id] === undefined` means "not loaded yet".
	let accountCalendars = $state<Record<string, CalendarInfo[]>>({});
	let accountExcluded = $state<Record<string, Set<string>>>({});

	function parseExcluded(json: string | null): Set<string> {
		if (!json) return new Set();
		try {
			return new Set(JSON.parse(json) as string[]);
		} catch {
			return new Set();
		}
	}

	// Load calendars for every connected Google account (skipping already-cached
	// ones), and keep each account's exclusion set in sync with the latest data.
	async function loadAllAccountCalendars(): Promise<void> {
		await Promise.all(
			googleAccounts.map(async (acct) => {
				accountExcluded = {
					...accountExcluded,
					[acct.id]: parseExcluded(acct.excluded_calendar_ids),
				};
				if (accountCalendars[acct.id] !== undefined) return;
				const res = await commands.calendarListAccountCalendars(acct.id);
				// On failure (e.g. a reauth-required account) fall back to an empty list;
				// the account row already surfaces the reconnect prompt.
				accountCalendars = {
					...accountCalendars,
					[acct.id]: res.status === 'ok' ? res.data : [],
				};
			}),
		);
	}

	// Refreshing an account's calendar list is a manual action: it is the only path
	// that hits Google's API (the page otherwise renders the cached list).
	let refreshingAccounts = $state<Set<string>>(new Set());

	async function refreshAccountCalendars(accountId: string): Promise<void> {
		refreshingAccounts = new Set(refreshingAccounts).add(accountId);
		try {
			const res = await commands.calendarRefreshAccountCalendars(accountId);
			if (res.status === 'ok') {
				accountCalendars = { ...accountCalendars, [accountId]: res.data };
			} else {
				toast.error('Could not refresh calendars', { description: res.error });
			}
		} finally {
			const next = new Set(refreshingAccounts);
			next.delete(accountId);
			refreshingAccounts = next;
		}
	}

	async function toggleAccountCalendar(
		accountId: string,
		calId: string,
		include: boolean,
	): Promise<void> {
		const prev = accountExcluded;
		const next = new Set(accountExcluded[accountId] ?? new Set<string>());
		if (include) next.delete(calId);
		else next.add(calId);
		accountExcluded = { ...accountExcluded, [accountId]: next };
		const res = await commands.calendarSetAccountExcludedIds(accountId, [...next]);
		if (res.status === 'error') {
			accountExcluded = prev; // revert the optimistic change on failure
			toast.error('Could not update calendar selection', { description: res.error });
		}
	}

	// Upcoming-events preview (verification that sources are being read).
	let previewEvents = $state<{ title: string; start: string; source: string }[] | null>(null);
	let previewLoading = $state(false);

	async function loadPreview(): Promise<void> {
		previewLoading = true;
		try {
			const res = await commands.calendarPreviewUpcoming();
			if (res.status === 'ok') previewEvents = res.data;
			else toast.error('Could not load events', { description: res.error });
		} finally {
			previewLoading = false;
		}
	}

	async function loadCalendars(): Promise<void> {
		const list = await commands.calendarListCalendars();
		if (list.status === 'ok') calendars = list.data;
		const ex = await commands.calendarGetExcludedIds();
		if (ex.status === 'ok') excludedIds = new Set(ex.data);
		localCalendarsLoaded = true;
	}

	onMount(() => {
		void (async () => {
			try {
				// Fetch the quick core state concurrently so the page reveals fast,
				// instead of blocking on six sequential round-trips.
				const [perm, en, names, notes, accountsList, googleCfg] = await Promise.all([
					commands.calendarPermissionStatus(),
					commands.calendarGetContextEnabled(),
					commands.calendarGetSendAttendeeNamesToCloud(),
					commands.calendarGetSendNotesToCloud(),
					commands.calendarListAccounts(),
					commands.calendarGoogleConfigured(),
				]);
				authStatus = perm;
				if (en.status === 'ok') enabled = en.data;
				if (names.status === 'ok') sendNames = names.data;
				if (notes.status === 'ok') sendNotes = notes.data;
				if (accountsList.status === 'ok') accounts = accountsList.data;
				googleConfigured = googleCfg;
			} finally {
				loading = false;
			}
			// Reveal the toggles immediately; the calendar lists load in the background,
			// each with its own loading state. The local (EventKit) read can be slow and
			// the per-account Google lists come from the cache.
			if (granted) void loadCalendars();
			void loadAllAccountCalendars();
		})();
	});

	// Permission is requested when the local "On this Mac" source is enabled
	// (see toggleAccount); the master toggle doesn't gate on it since Google
	// sources work without EventKit access.
	async function handleEnableToggle(next: boolean): Promise<void> {
		enabled = next;
		const res = await commands.calendarSetContextEnabled(next);
		if (res.status === 'error') {
			enabled = !next;
			toast.error('Failed to update calendar setting', { description: res.error });
		}
	}

	async function toggleCalendar(id: string, include: boolean): Promise<void> {
		const prev = excludedIds;
		const next = new Set(excludedIds);
		if (include) next.delete(id);
		else next.add(id);
		excludedIds = next;
		const res = await commands.calendarSetExcludedIds([...next]);
		if (res.status === 'error') {
			excludedIds = prev; // revert the optimistic change on failure
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

<div class="flex flex-col gap-6">
	<div>
		<p class="mb-6 text-sm text-muted-foreground">
			muesly attaches the meeting happening at record time to your recordings and summaries. Use
			your Mac's local calendars (read entirely on-device, no account) and/or connect Google
			accounts (read-only). Everything is off by default; what reaches a cloud summary provider is
			controlled separately below.
		</p>
	</div>
	<Loadable {loading}>
		<Card.Root class="flex flex-row items-center justify-between p-4">
			<div class="flex-1">
				<div class="font-medium">Use calendar context</div>
				<div class="text-sm text-muted-foreground">
					Match each recording to the meeting happening at that time.
				</div>
			</div>
			<Switch checked={enabled} disabled={requesting} onCheckedChange={handleEnableToggle} />
		</Card.Root>

		{#if enabled}
			<Card.Root class="p-4">
				<div class="mb-1 font-medium">Calendar sources</div>
				<div class="mb-3 text-sm text-muted-foreground">
					Enable one or more sources. Events from all enabled sources are matched to your
					recordings.
				</div>
				<div class="flex flex-col gap-2">
					<!-- Local macOS source (calendars always shown, like Google accounts).
					     EventKit is macOS-only, so other platforms don't get the row at all
					     even though the eventkit-local account row exists in the DB. -->
					{#if platform.isMac}
						<div class="flex flex-col gap-2">
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0 flex-1 truncate text-sm">
									On this Mac
									{#if !granted}
										<span class="ml-2 text-xs text-warning">(calendar access needed)</span>
									{/if}
								</div>
								{#if localAccount}
									<Switch
										checked={localAccount.enabled && granted}
										disabled={requesting}
										onCheckedChange={(v) => toggleAccount(localAccount.id, v)}
									/>
								{/if}
							</div>

							{#if granted}
								<div
									class={cn(
										'divide-y divide-border/60 overflow-hidden rounded-md border border-border/60 bg-muted/20 transition-opacity',
										localAccount && !localAccount.enabled && 'opacity-50',
									)}
								>
									{#if !localCalendarsLoaded}
										<div class="px-3 py-2 text-xs text-muted-foreground">Loading calendars…</div>
									{:else if calendars.length === 0}
										<div class="px-3 py-2 text-xs text-muted-foreground">No calendars found.</div>
									{:else}
										{#each calendars as cal (cal.id)}
											<div class="flex items-center justify-between gap-3 px-3 py-2">
												<span class="min-w-0 flex-1 truncate text-sm">
													{cal.title}
													{#if cal.excluded_by_default}
														<span class="ml-1 text-xs text-muted-foreground"
															>(excluded by default)</span
														>
													{/if}
												</span>
												<Switch
													checked={!cal.excluded_by_default && !excludedIds.has(cal.id)}
													disabled={cal.excluded_by_default}
													onCheckedChange={(v) => toggleCalendar(cal.id, v)}
												/>
											</div>
										{/each}
									{/if}
								</div>
							{/if}
						</div>
					{/if}

					<!-- Connected Google accounts (calendars always shown) -->
					{#each googleAccounts as acct (acct.id)}
						{@const cals = accountCalendars[acct.id]}
						<div class="flex flex-col gap-2">
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0 flex-1 truncate text-sm">
									{acct.email ?? 'Google account'}
									{#if acct.status === 'reauth_required'}
										<span class="ml-2 text-xs text-warning"
											>(reconnect needed - remove &amp; re-add)</span
										>
									{/if}
								</div>
								<div class="flex flex-shrink-0 items-center gap-3">
									<Switch
										checked={acct.enabled}
										onCheckedChange={(v) => toggleAccount(acct.id, v)}
									/>
									<Tooltip.Provider delayDuration={300}>
										<Tooltip.Root>
											<Tooltip.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														size="icon-sm"
														class="text-muted-foreground hover:text-foreground"
														onclick={() => refreshAccountCalendars(acct.id)}
														disabled={refreshingAccounts.has(acct.id)}
														aria-label="Refresh calendars"
													>
														<RefreshCw
															class={cn(refreshingAccounts.has(acct.id) && 'animate-spin')}
														/>
													</Button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content>Refresh calendars from Google</Tooltip.Content>
										</Tooltip.Root>
									</Tooltip.Provider>
									<Button
										variant="ghost"
										size="sm"
										class="text-muted-foreground hover:text-destructive"
										onclick={() => removeAccount(acct.id)}
										aria-label="Remove account"
									>
										Remove
									</Button>
								</div>
							</div>

							<!-- Calendar list: always visible, one toggle per calendar -->
							<div
								class={cn(
									'divide-y divide-border/60 overflow-hidden rounded-md border border-border/60 bg-muted/20 transition-opacity',
									!acct.enabled && 'opacity-50',
								)}
							>
								{#if cals === undefined}
									<div class="px-3 py-2 text-xs text-muted-foreground">Loading calendars…</div>
								{:else if cals.length === 0}
									<div class="px-3 py-2 text-xs text-muted-foreground">No calendars found.</div>
								{:else}
									{#each cals as cal (cal.id)}
										<div class="flex items-center justify-between gap-3 px-3 py-2">
											<span class="min-w-0 flex-1 truncate text-sm">{cal.title}</span>
											<Switch
												checked={!accountExcluded[acct.id]?.has(cal.id)}
												onCheckedChange={(v) => toggleAccountCalendar(acct.id, cal.id, v)}
											/>
										</div>
									{/each}
								{/if}
							</div>
						</div>
					{/each}
				</div>

				<div class="mt-4">
					{#if googleConfigured}
						<Button variant="outline" size="sm" onclick={addGoogleAccount}>
							<Calendar data-icon="inline-start" />
							Add Google account
						</Button>
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
			</Card.Root>
		{/if}

		{#if enabled && granted}
			<Card.Root class="p-4">
				<div class="mb-1 font-medium">Cloud summaries</div>
				<div class="mb-3 text-sm text-muted-foreground">
					When you use a cloud summary provider, these control what calendar data may leave your
					device. Attendee emails are never sent or stored.
				</div>
				<Alert.Root class="mb-4 border-warning/50 bg-warning/10 text-warning">
					<ShieldAlert />
					<Alert.Description class="text-warning/90">
						<p>
							With a cloud provider selected, anything enabled below is sent to that provider when a
							summary is generated. Local summaries always include full context and send nothing.
						</p>
					</Alert.Description>
				</Alert.Root>
				<div class="flex items-center justify-between py-2">
					<div class="text-sm">Send attendee &amp; organizer names</div>
					<Switch checked={sendNames} onCheckedChange={toggleSendNames} />
				</div>
				<div class="flex items-center justify-between py-2">
					<div class="text-sm">Send agenda / notes</div>
					<Switch checked={sendNotes} onCheckedChange={toggleSendNotes} />
				</div>
			</Card.Root>
		{/if}

		{#if enabled}
			<Card.Root class="p-4">
				<div class="mb-1 font-medium">Upcoming events</div>
				<div class="mb-3 text-sm text-muted-foreground">
					Preview what muesly reads from your enabled sources (next ~24 hours).
				</div>
				<Button variant="outline" size="sm" disabled={previewLoading} onclick={loadPreview}>
					{previewLoading ? 'Loading…' : 'Preview events'}
				</Button>
				{#if previewEvents !== null}
					{#if previewEvents.length === 0}
						<div class="mt-3 text-sm text-muted-foreground">No upcoming events found.</div>
					{:else}
						<div class="mt-3 flex flex-col gap-1">
							{#each previewEvents as ev (ev.start + ev.title)}
								<div class="flex items-center justify-between text-sm">
									<span class="truncate">{ev.title}</span>
									<span class="ml-3 shrink-0 text-xs text-muted-foreground">
										{new Date(ev.start).toLocaleString([], {
											month: 'short',
											day: 'numeric',
											hour: '2-digit',
											minute: '2-digit',
										})}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</Card.Root>
		{/if}

		<Card.Root class="flex flex-row items-center justify-between p-4">
			<div class="flex-1">
				<div class="font-medium">Delete stored calendar data</div>
				<div class="text-sm text-muted-foreground">
					Remove every calendar snapshot saved with your recordings, keeping the recordings.
				</div>
			</div>
			<Button variant="outline" size="sm" onclick={purgeData}>
				<Trash2 data-icon="inline-start" /> Delete
			</Button>
		</Card.Root>
	</Loadable>
</div>
