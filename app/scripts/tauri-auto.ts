#!/usr/bin/env node
/**
 * Auto-detect GPU and run Tauri (dev|build) with the appropriate cargo features.
 * Override detection with the TAURI_GPU_FEATURE environment variable.
 */
import { execSync } from 'node:child_process';
import os from 'node:os';

const command = process.argv[2];
if (!command || !['dev', 'build'].includes(command)) {
	console.error('Usage: node tauri-auto.ts [dev|build]');
	process.exit(1);
}

let feature = '';
if (process.env.TAURI_GPU_FEATURE) {
	feature = process.env.TAURI_GPU_FEATURE;
	console.log(`🔧 Using forced GPU feature from environment: ${feature}`);
} else {
	try {
		feature = execSync('node scripts/auto-detect-gpu.ts', {
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'inherit']
		}).trim();
	} catch {
		// Detection failed → fall back to CPU (no feature).
	}
}

console.log(''); // Spacing

const env = { ...process.env };
if (os.platform() === 'linux' && feature === 'cuda') {
	console.log('🐧 Linux/CUDA detected: Setting CMAKE flags for NVIDIA GPU');
	// Defaults only — values already set in the environment take precedence.
	env.CMAKE_CUDA_ARCHITECTURES ??= '75';
	env.CMAKE_CUDA_STANDARD ??= '17';
	env.CMAKE_POSITION_INDEPENDENT_CODE ??= 'ON';
}

let tauriCmd = `tauri ${command}`;
if (feature && feature !== 'none') {
	tauriCmd += ` -- --features ${feature}`;
	console.log(`🚀 Running: tauri ${command} with features: ${feature}`);
} else {
	console.log(`🚀 Running: tauri ${command} (CPU-only mode)`);
}
console.log('');

try {
	execSync(tauriCmd, { stdio: 'inherit', env });
} catch (err) {
	process.exit((err as { status?: number }).status ?? 1);
}
