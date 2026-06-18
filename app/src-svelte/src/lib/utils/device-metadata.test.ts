import { describe, it, expect } from 'vitest';
import { getDeviceMetadata } from './device-metadata';

describe('getDeviceMetadata', () => {
	it('returns only isBluetooth and category keys', () => {
		const result = getDeviceMetadata('AirPods Pro');
		const keys = Object.keys(result);
		expect(keys).toEqual(['isBluetooth', 'category']);
	});

	it('does not expose a device name field', () => {
		const result = getDeviceMetadata('AirPods Pro') as Record<string, unknown>;
		expect(result).not.toHaveProperty('name');
		expect(result).not.toHaveProperty('device_name');
		expect(result).not.toHaveProperty('deviceName');
	});

	it('classifies AirPods as bluetooth', () => {
		const result = getDeviceMetadata('AirPods Pro');
		expect(result.isBluetooth).toBe(true);
		expect(result.category).toBe('airpods');
	});

	it('classifies wired devices correctly', () => {
		const result = getDeviceMetadata('MacBook Pro Microphone');
		expect(result.isBluetooth).toBe(false);
		expect(result.category).toBe('wired');
	});

	it('handles the default device name', () => {
		const result = getDeviceMetadata('default');
		expect(result.category).toBe('default');
	});
});
