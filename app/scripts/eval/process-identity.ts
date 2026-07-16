import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function processIsAlive(pid) {
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
	if (!Number.isInteger(pid) || pid < 1 || !processIsAlive(pid)) return null;
	try {
		if (process.platform === 'linux') return linuxProcessIdentity(pid);
		if (process.platform === 'win32') return windowsProcessIdentity(pid);
		return posixProcessIdentity(pid);
	} catch {
		return null;
	}
}

export function processOwnsState(
	owner,
	{ isAlive = processIsAlive, identityForPid = processIdentity } = {},
) {
	if (!Number.isInteger(owner?.pid) || owner.pid < 1 || !isAlive(owner.pid)) return false;
	if (typeof owner.process_identity !== 'string' || owner.process_identity.length === 0) {
		return true;
	}
	const identity = identityForPid(owner.pid);
	return identity === null || identity === owner.process_identity;
}
