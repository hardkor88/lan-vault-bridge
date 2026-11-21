import type { App } from 'obsidian';

/**
 * Версия схемы манифеста. Увеличивается при несовместимых изменениях формата.
 */
export const MANIFEST_SCHEMA_VERSION = 1;

export const DEFAULT_SERVER_PORT = 27123;

export type FileStatus = 'active' | 'deleted_tombstone';

/**
 * Запись о файле в манифесте. Tombstone-записи никогда не удаляются автоматически:
 * это и есть защита от случайного удаления и от «воскрешения» файлов.
 */
export interface FileMetadata {
	path: string;
	sha256: string;
	mtime: number;
	size: number;
	status: FileStatus;
	deletedAt?: number;
	lastModifiedDevice: string;
}

export interface VaultManifest {
	schemaVersion: number;
	deviceId: string;
	deviceName: string;
	updatedAt: number;
	files: Record<string, FileMetadata>;
}

/**
 * Причина попадания файла в секцию «Наличие файлов».
 */
export type ConflictReason =
	| 'only_on_client'
	| 'only_on_server'
	| 'deleted_on_server'
	| 'deleted_on_client'
	| 'modified_after_server_delete'
	| 'modified_after_client_delete';

export interface FileConflict {
	path: string;
	reason: ConflictReason;
	client?: FileMetadata;
	server?: FileMetadata;
}

export interface ContentDiff {
	path: string;
	client: FileMetadata;
	server: FileMetadata;
}

export interface SyncDiff {
	generatedAt: number;
	serverDeviceName: string;
	fileConflicts: FileConflict[];
	contentDiffs: ContentDiff[];
}

export interface PingResponse {
	status: 'ok';
	deviceName: string;
	version: string;
}

export interface ApiErrorBody {
	status: 'error';
	message: string;
	code?: string;
}

export interface DownloadedFile {
	data: ArrayBuffer;
	mtime: number;
	sha256: string;
	size: number;
}

export interface ReconcileResult {
	scanned: number;
	hashed: number;
	restored: number;
	tombstoned: number;
	oversized: string[];
}

export type UiLanguage = 'auto' | 'en' | 'ru';

export interface LanSyncSettings {
	deviceId: string;
	deviceName: string;
	uiLanguage: UiLanguage;
	/** Write diagnostic messages to the developer console. */
	debugLogging: boolean;
	/** Запускать HTTP-сервер (имеет смысл только на desktop). */
	serverEnabled: boolean;
	serverPort: number;
	/** 32 hex-символа, общий секрет для Bearer-авторизации. */
	authToken: string;
	clientHost: string;
	clientPort: number;
	clientToken: string;
	requestTimeoutMs: number;
	maxFileSizeMb: number;
	excludedFolders: string[];
}

export const DEFAULT_SETTINGS: LanSyncSettings = {
	deviceId: '',
	deviceName: '',
	uiLanguage: 'auto',
	debugLogging: false,
	serverEnabled: true,
	serverPort: DEFAULT_SERVER_PORT,
	authToken: '',
	clientHost: '',
	clientPort: DEFAULT_SERVER_PORT,
	clientToken: '',
	requestTimeoutMs: 20000,
	maxFileSizeMb: 50,
	excludedFolders: [],
};

/**
 * Контекст, который плагин предоставляет менеджеру манифеста и серверу.
 * Позволяет не завязываться на конкретный класс плагина и не плодить циклические импорты.
 */
export interface SyncHost {
	app: App;
	manifest: { id: string; dir?: string; version: string };
	getSettings(): LanSyncSettings;
	saveSettings(): Promise<void>;
	getDeviceId(): string;
	getDeviceName(): string;
}

export interface ConnectionPayload {
	ip: string;
	port: number;
	token: string;
}

export interface LocalAddressInfo {
	address: string;
	iface: string;
	score: number;
}

declare global {
	interface Window {
		/** Node.js require доступен только в desktop-сборке Obsidian (Electron). */
		require?: (moduleId: string) => unknown;
	}
}
