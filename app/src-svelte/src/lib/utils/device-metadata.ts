export function getDeviceMetadata(deviceName: string): { isBluetooth: boolean; category: string } {
	const nameLower = deviceName.toLowerCase();
	const isBluetooth =
		nameLower.includes('airpods') ||
		nameLower.includes('bluetooth') ||
		nameLower.includes('wireless') ||
		nameLower.includes('wh-') ||
		nameLower.includes('bt ');

	let category = 'wired';
	if (deviceName === 'default') category = 'default';
	else if (nameLower.includes('airpods')) category = 'airpods';
	else if (isBluetooth) category = 'bluetooth';

	return { isBluetooth, category };
}
