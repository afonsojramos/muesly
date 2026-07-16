import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const CURRENT_PROCESS_IDENTITY =
	`node:${process.pid}:` + Math.round((Date.now() - process.uptime() * 1000) / 1000);

function currentBootIdentity() {
	try {
		return (
			`${process.platform}:boot:` +
			Math.round((Date.now() - os.uptime() * 1000) / 10_000)
		);
	} catch {
		return null;
	}
}

const CURRENT_BOOT_IDENTITY = currentBootIdentity();

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== 'ESRCH';
	}
}

function linuxProcessIdentity(pid) {
	const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
	const commandEnd = stat.lastIndexOf(')');
	if (commandEnd === -1) return null;
	const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
	const startTicks = fields[19];
	const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
	return startTicks && bootId ? `linux:${bootId}:${startTicks}` : null;
}

function posixProcessIdentity(pid) {
	const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	}).trim();
	return startedAt ? `${process.platform}:${startedAt}` : null;
}

function windowsProcessIdentity(pid) {
	const command =
		`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}")` +
		'.CreationDate.ToUniversalTime().Ticks';
	const startedAt = execFileSync(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-Command', command],
		{
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		},
	).trim();
	return startedAt ? `win32:${startedAt}` : null;
}

export function processIdentity(pid) {
	if (!Number.isInteger(pid) || pid < 1 || !processExists(pid)) return null;
	try {
		if (process.platform === 'linux') return linuxProcessIdentity(pid);
		if (process.platform === 'win32') return windowsProcessIdentity(pid);
		return posixProcessIdentity(pid);
	} catch {
		return pid === process.pid ? CURRENT_PROCESS_IDENTITY : null;
	}
}

export function bootIdentity() {
	return CURRENT_BOOT_IDENTITY;
}

export function processOwnsState(owner) {
	if (!Number.isInteger(owner?.pid) || owner.pid < 1 || !processExists(owner.pid)) return false;
	if (
		typeof owner.boot_identity === 'string' &&
		owner.boot_identity.length > 0 &&
		CURRENT_BOOT_IDENTITY !== null &&
		owner.boot_identity !== CURRENT_BOOT_IDENTITY
	) {
		return false;
	}
	if (typeof owner.process_identity !== 'string' || owner.process_identity.length === 0) {
		return true;
	}
	const identity = processIdentity(owner.pid);
	return identity === null || identity === owner.process_identity;
}
