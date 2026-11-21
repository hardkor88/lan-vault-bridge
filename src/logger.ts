let debugEnabled = false;

export function setDebugLogging(enabled: boolean): void {
	debugEnabled = enabled;
}

export function isDebugLogging(): boolean {
	return debugEnabled;
}

function prefix(): string {
	return '[LAN Vault Bridge]';
}

export function debugLog(...args: unknown[]): void {
	if (debugEnabled) {
		console.debug(prefix(), ...args);
	}
}

export function warnLog(...args: unknown[]): void {
	if (debugEnabled) {
		console.warn(prefix(), ...args);
	}
}

export function errorLog(...args: unknown[]): void {
	if (debugEnabled) {
		console.error(prefix(), ...args);
	}
}
