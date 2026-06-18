#!/usr/bin/env node
/**
 * Auto-detect GPU capabilities and emit the appropriate Tauri feature on stdout.
 * Detection messages go to stderr so only the feature name lands on stdout.
 * Consumed by tauri-auto.ts.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

type GpuFeature = 'coreml' | 'metal' | 'cuda' | 'hipblas' | 'vulkan' | 'openblas';

function commandExists(cmd: string): boolean {
	try {
		execSync(`${os.platform() === 'win32' ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function detectGPU(): GpuFeature | null {
	const platform = os.platform();

	// macOS: Metal is always available; Apple Silicon adds CoreML.
	if (platform === 'darwin') {
		if (os.arch() === 'arm64') {
			console.log('🍎 Apple Silicon detected - using Metal + CoreML');
			return 'coreml'; // CoreML includes Metal
		}
		console.log('🍎 macOS Intel detected - using Metal');
		return 'metal';
	}

	if (platform === 'win32' || platform === 'linux') {
		// NVIDIA / CUDA
		if (commandExists('nvidia-smi')) {
			if (process.env.CUDA_PATH || commandExists('nvcc')) {
				console.log('🟢 NVIDIA GPU detected with CUDA - using CUDA acceleration');
				return 'cuda';
			}
			console.log('⚠️  NVIDIA GPU detected but CUDA not installed - falling back to CPU');
			return null;
		}

		// AMD / ROCm (Linux only)
		if (platform === 'linux' && commandExists('rocm-smi')) {
			if (process.env.ROCM_PATH || commandExists('hipcc')) {
				console.log('🔴 AMD GPU detected with ROCm - using HIPBlas acceleration');
				return 'hipblas';
			}
			console.log('⚠️  AMD GPU detected but ROCm not installed - falling back to CPU');
			return null;
		}

		// Vulkan
		if (commandExists('vulkaninfo') || (platform === 'win32' && existsSync('C:\\VulkanSDK'))) {
			const vulkanSdk = process.env.VULKAN_SDK;
			const blasInclude = process.env.BLAS_INCLUDE_DIRS;
			if (vulkanSdk && blasInclude) {
				console.log('🔵 Vulkan detected with all dependencies - using Vulkan acceleration');
				return 'vulkan';
			}
			console.log('⚠️  Vulkan detected but missing dependencies - falling back to CPU');
			if (!vulkanSdk) console.log('   Missing: VULKAN_SDK environment variable');
			if (!blasInclude) console.log('   Missing: BLAS_INCLUDE_DIRS environment variable');
			return null;
		}

		// OpenBLAS CPU optimization
		if (process.env.BLAS_INCLUDE_DIRS) {
			console.log('📊 OpenBLAS detected - using CPU with BLAS optimization');
			return 'openblas';
		}
	}

	console.log('💻 No GPU acceleration available - using CPU-only mode');
	return null;
}

// Route detection chatter to stderr so stdout carries only the feature name.
const originalLog = console.log;
console.log = (...args: unknown[]): void => {
	process.stderr.write(args.join(' ') + '\n');
};
const feature = detectGPU();
console.log = originalLog;

if (feature) {
	process.stdout.write(feature);
}
