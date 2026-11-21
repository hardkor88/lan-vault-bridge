import { TFile, TFolder } from 'obsidian';
import type { Stat, TAbstractFile } from 'obsidian';
import type {
	FileConflict,
	FileMetadata,
	ReconcileResult,
	SyncDiff,
	SyncHost,
	VaultManifest,
} from './types';
import { MANIFEST_SCHEMA_VERSION } from './types';
import { errorMessage, isPathIgnored, normalizeVaultPath, parentFolder } from './utils';
import { t } from './i18n';
import { debugLog, errorLog, warnLog } from './logger';

/**
 * SHA-256 через Web Crypto API. Работает одинаково в Electron и в Android/iOS WebView,
 * не требует Node.js и не тянет в бандл криптомодуль.
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle || typeof subtle.digest !== 'function') {
		throw new Error(
			t(
				'Web Crypto API (crypto.subtle) is unavailable: cannot compute SHA-256.',
				'Web Crypto API (crypto.subtle) недоступен: невозможно вычислить SHA-256.',
			),
		);
	}
	const digest = await subtle.digest('SHA-256', data);
	return bufferToHex(digest);
}

export function bufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = '';
	for (let i = 0; i < bytes.length; i += 1) {
		hex += bytes[i].toString(16).padStart(2, '0');
	}
	return hex;
}

function copyMetadata(metadata: FileMetadata): FileMetadata {
	return { ...metadata };
}

/**
 * Словарь без прототипа: путь вида `__proto__` не должен менять прототип объекта.
 */
function createFileMap(): Record<string, FileMetadata> {
	return Object.create(null) as Record<string, FileMetadata>;
}

function isFileLike(file: TAbstractFile): file is TFile {
	const candidate = file as TFile;
	return typeof candidate.basename === 'string' && typeof candidate.extension === 'string';
}

function normalizeFileMetadata(key: string, value: unknown): FileMetadata | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const record = value as Partial<FileMetadata>;
	const path = normalizeVaultPath(typeof record.path === 'string' && record.path ? record.path : key);
	if (!path) {
		return null;
	}
	if (record.status !== 'active' && record.status !== 'deleted_tombstone') {
		return null;
	}
	const mtime = typeof record.mtime === 'number' && Number.isFinite(record.mtime) ? record.mtime : 0;
	const size = typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0
		? record.size
		: 0;
	const deletedAt = typeof record.deletedAt === 'number' && Number.isFinite(record.deletedAt)
		? record.deletedAt
		: undefined;
	return {
		path,
		sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
		mtime,
		size,
		status: record.status,
		...(deletedAt === undefined ? {} : { deletedAt }),
		lastModifiedDevice: typeof record.lastModifiedDevice === 'string' ? record.lastModifiedDevice : '',
	};
}

/** Валидирует и нормализует манифест, пришедший из data.json или по сети. */
export function normalizeManifest(raw: unknown): VaultManifest | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const filesRaw = record.files;
	if (!filesRaw || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
		return null;
	}
	const files = createFileMap();
	for (const [key, value] of Object.entries(filesRaw as Record<string, unknown>)) {
		const metadata = normalizeFileMetadata(key, value);
		if (metadata) {
			files[metadata.path] = metadata;
		}
	}
	return {
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
		deviceName: typeof record.deviceName === 'string' ? record.deviceName : '',
		updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
			? record.updatedAt
			: 0,
		files,
	};
}

/**
 * Сравнивает манифесты клиента и сервера.
 *
 * fileConflicts — разное «наличие» файла (только на одной стороне, удаление на одной
 * стороне при активном файле на другой, изменение после удаления).
 * contentDiffs — файл active на обеих сторонах, но содержимое (sha256) различается.
 */
export function computeSyncDiff(
	client: VaultManifest,
	server: VaultManifest,
	serverDeviceName: string,
): SyncDiff {
	const fileConflicts: FileConflict[] = [];
	const contentDiffs: SyncDiff['contentDiffs'] = [];
	const paths = new Set<string>([...Object.keys(client.files), ...Object.keys(server.files)]);

	for (const path of Array.from(paths).sort((left, right) => left.localeCompare(right))) {
		const clientMeta = client.files[path];
		const serverMeta = server.files[path];

		if (!clientMeta && !serverMeta) {
			continue;
		}
		if (!clientMeta) {
			if (serverMeta && serverMeta.status === 'active') {
				fileConflicts.push({ path, reason: 'only_on_server', server: copyMetadata(serverMeta) });
			}
			continue;
		}
		if (!serverMeta) {
			if (clientMeta.status === 'active') {
				fileConflicts.push({ path, reason: 'only_on_client', client: copyMetadata(clientMeta) });
			}
			continue;
		}
		if (clientMeta.status === 'active' && serverMeta.status === 'active') {
			if (clientMeta.sha256 !== serverMeta.sha256) {
				contentDiffs.push({
					path,
					client: copyMetadata(clientMeta),
					server: copyMetadata(serverMeta),
				});
			}
			continue;
		}
		if (clientMeta.status === 'deleted_tombstone' && serverMeta.status === 'active') {
			const modifiedAfterDelete = serverMeta.mtime > (clientMeta.deletedAt ?? 0);
			fileConflicts.push({
				path,
				reason: modifiedAfterDelete ? 'modified_after_client_delete' : 'deleted_on_client',
				client: copyMetadata(clientMeta),
				server: copyMetadata(serverMeta),
			});
			continue;
		}
		if (clientMeta.status === 'active' && serverMeta.status === 'deleted_tombstone') {
			const modifiedAfterDelete = clientMeta.mtime > (serverMeta.deletedAt ?? 0);
			fileConflicts.push({
				path,
				reason: modifiedAfterDelete ? 'modified_after_server_delete' : 'deleted_on_server',
				client: copyMetadata(clientMeta),
				server: copyMetadata(serverMeta),
			});
		}
	}

	return {
		generatedAt: Date.now(),
		serverDeviceName,
		fileConflicts,
		contentDiffs,
	};
}

export class ManifestManager {
	private readonly host: SyncHost;
	private manifest: VaultManifest;
	private loaded = false;
	private saveTimer: number | null = null;
	private saveChain: Promise<void> = Promise.resolve();
	private queue: Promise<unknown> = Promise.resolve();
	private pendingRefresh = new Set<string>();
	private refreshTimer: number | null = null;

	constructor(host: SyncHost) {
		this.host = host;
		this.manifest = this.createEmptyManifest();
	}

	get deviceId(): string {
		return this.host.getDeviceId();
	}

	get deviceName(): string {
		return this.host.getDeviceName();
	}

	/** `${manifest.dir}/sync-manifest.json` — внутри папки плагина, не индексируется как заметка. */
	getPath(): string {
		const configuredDir = (this.host.manifest.dir ?? '').trim();
		const dir = configuredDir
			? normalizeVaultPath(configuredDir)
			: `${normalizeVaultPath(this.host.app.vault.configDir)}/plugins/${this.host.manifest.id}`;
		return `${dir}/sync-manifest.json`;
	}

	getLoaded(): boolean {
		return this.loaded;
	}

	async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.manifest = this.createEmptyManifest();
		const path = this.getPath();
		const adapter = this.host.app.vault.adapter;
		try {
			if (await adapter.exists(path)) {
				const raw = await adapter.read(path);
				let parsed: unknown = null;
				try {
					parsed = JSON.parse(raw) as unknown;
				} catch (error) {
					errorLog('Manifest is corrupted; creating a new one.', error);
					await this.quarantineCorrupt(path);
				}
				if (parsed !== null) {
					const normalized = normalizeManifest(parsed);
					if (normalized) {
						this.manifest = {
							...normalized,
							schemaVersion: MANIFEST_SCHEMA_VERSION,
							deviceId: this.deviceId,
							deviceName: this.deviceName,
						};
					} else {
						errorLog('Unknown manifest format; creating a new one.');
						await this.quarantineCorrupt(path);
					}
				}
			}
		} catch (error) {
			errorLog('Failed to read the manifest.', error);
		}
		this.loaded = true;
		debugLog(`Manifest loaded from ${path}`, Object.keys(this.manifest.files).length, 'entries');
		await this.saveNow();
	}

	async saveNow(): Promise<void> {
		if (!this.loaded) {
			return;
		}
		this.manifest.schemaVersion = MANIFEST_SCHEMA_VERSION;
		this.manifest.deviceId = this.deviceId;
		this.manifest.deviceName = this.deviceName;
		this.manifest.updatedAt = Date.now();
		const json = JSON.stringify(this.manifest, null, 2);
		const path = this.getPath();
		const task = this.saveChain.then(async () => {
			await this.ensureManifestFolder(parentFolder(path));
			await this.host.app.vault.adapter.write(path, json);
		});
		this.saveChain = task.catch((error: unknown) => {
			errorLog('Failed to save the manifest.', error);
		});
		await this.saveChain;
	}

	scheduleSave(): void {
		if (this.saveTimer !== null) {
			return;
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, 600);
	}

	/** Сохраняет манифест при выгрузке плагина (асинхронно, но без ожидания таймера). */
	flush(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.pendingRefresh.clear();
		void this.saveNow();
	}

	snapshot(): VaultManifest {
		const files = createFileMap();
		for (const [path, metadata] of Object.entries(this.manifest.files)) {
			files[path] = copyMetadata(metadata);
		}
		return {
			schemaVersion: this.manifest.schemaVersion,
			deviceId: this.manifest.deviceId,
			deviceName: this.manifest.deviceName,
			updatedAt: this.manifest.updatedAt,
			files,
		};
	}

	getEntry(path: string): FileMetadata | undefined {
		const metadata = this.manifest.files[normalizeVaultPath(path)];
		return metadata ? copyMetadata(metadata) : undefined;
	}

	getTombstoneCount(): number {
		return Object.values(this.manifest.files).filter(
			(metadata) => metadata.status === 'deleted_tombstone',
		).length;
	}

	getActiveCount(): number {
		return Object.values(this.manifest.files).filter((metadata) => metadata.status === 'active')
			.length;
	}

	/**
	 * Полная сверка с диском. Пересчитывает хеш только там, где изменились mtime/size,
	 * поэтому повторные запуски дешёвые. Файлы, пропавшие с диска, получают tombstone,
	 * а не удаляются из манифеста.
	 */
	reconcile(onProgress?: (scanned: number, total: number) => void): Promise<ReconcileResult> {
		return this.runExclusive(async () => {
			const settings = this.host.getSettings();
			const maxBytes = settings.maxFileSizeMb * 1024 * 1024;
			const files = this.host.app.vault.getFiles();
			const result: ReconcileResult = {
				scanned: 0,
				hashed: 0,
				restored: 0,
				tombstoned: 0,
				oversized: [],
			};
			const present = new Set<string>();
			const total = files.length;
			let index = 0;

			for (const file of files) {
				index += 1;
				if (onProgress && (index === total || index % 25 === 0)) {
					onProgress(index, total);
				}
				const path = normalizeVaultPath(file.path);
				if (!path || this.isIgnored(path)) {
					continue;
				}
				present.add(path);
				const stat = await this.statForFile(file);
				if (!stat || stat.type !== 'file') {
					continue;
				}
				result.scanned += 1;
				if (stat.size > maxBytes) {
					result.oversized.push(path);
					if (this.manifest.files[path]) {
						delete this.manifest.files[path];
					}
					continue;
				}
				const existing = this.manifest.files[path];
				const unchanged = existing
					&& existing.status === 'active'
					&& existing.mtime === stat.mtime
					&& existing.size === stat.size;
				if (unchanged) {
					continue;
				}
				const data = await this.readBinarySafe(path);
				if (!data) {
					continue;
				}
				const sha256 = await sha256Hex(data);
				const wasTombstone = existing?.status === 'deleted_tombstone';
				const device = existing && existing.sha256 === sha256
					? existing.lastModifiedDevice
					: this.deviceName;
				this.manifest.files[path] = {
					path,
					sha256,
					mtime: stat.mtime,
					size: stat.size,
					status: 'active',
					lastModifiedDevice: device || this.deviceName,
				};
				result.hashed += 1;
				if (wasTombstone) {
					result.restored += 1;
				}
			}

			for (const [path, metadata] of Object.entries(this.manifest.files)) {
				if (this.isIgnored(path)) {
					delete this.manifest.files[path];
					continue;
				}
				if (metadata.status === 'active' && !present.has(path)) {
					metadata.status = 'deleted_tombstone';
					metadata.deletedAt = Date.now();
					metadata.lastModifiedDevice = this.deviceName;
					result.tombstoned += 1;
				}
			}

			this.scheduleSave();
			return result;
		});
	}

	refreshPath(path: string): Promise<FileMetadata | null> {
		return this.runExclusive(() => this.refreshPathInternal(path));
	}

	handleCreate(file: TAbstractFile): Promise<void> {
		if (!isFileLike(file)) {
			return Promise.resolve();
		}
		this.scheduleRefresh(normalizeVaultPath(file.path));
		return Promise.resolve();
	}

	handleModify(file: TAbstractFile): Promise<void> {
		if (!isFileLike(file)) {
			return Promise.resolve();
		}
		this.scheduleRefresh(normalizeVaultPath(file.path));
		return Promise.resolve();
	}

	handleDelete(file: TAbstractFile): Promise<void> {
		return this.runExclusive(async () => {
			const path = normalizeVaultPath(file.path);
			if (!path) {
				return;
			}
			if (isFileLike(file)) {
				this.tombstonePathInternal(path);
			} else {
				this.tombstoneFolderInternal(path);
			}
			this.scheduleSave();
		});
	}

	handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
		return this.runExclusive(async () => {
			const previous = normalizeVaultPath(oldPath);
			if (previous) {
				if (isFileLike(file)) {
					this.tombstonePathInternal(previous);
				} else {
					this.tombstoneFolderInternal(previous);
				}
			}
			const next = normalizeVaultPath(file.path);
			if (next && !this.isIgnored(next)) {
				if (isFileLike(file)) {
					await this.refreshPathInternal(next);
				} else {
					await this.refreshPrefix(next);
				}
			}
			this.scheduleSave();
		});
	}

	/** Ставит tombstone; при createIfMissing создаёт запись даже для неизвестного пути. */
	markTombstone(
		path: string,
		deviceName?: string,
		createIfMissing = false,
	): Promise<FileMetadata | null> {
		return this.runExclusive(async () => {
			const normalized = normalizeVaultPath(path);
			if (!normalized) {
				return null;
			}
			let metadata = this.manifest.files[normalized];
			if (!metadata) {
				if (!createIfMissing) {
					return null;
				}
				metadata = {
					path: normalized,
					sha256: '',
					mtime: 0,
					size: 0,
					status: 'deleted_tombstone',
					deletedAt: Date.now(),
					lastModifiedDevice: deviceName ?? this.deviceName,
				};
			} else {
				metadata.status = 'deleted_tombstone';
				metadata.deletedAt = Date.now();
				metadata.lastModifiedDevice = deviceName ?? this.deviceName;
			}
			this.manifest.files[normalized] = metadata;
			await this.saveNow();
			return copyMetadata(metadata);
		});
	}

	/** Записывает в манифест актуальное состояние файла (после upload/download). */
	recordFileState(
		path: string,
		sha256: string,
		mtime: number,
		size: number,
		deviceName?: string,
		persist = true,
	): Promise<FileMetadata> {
		return this.runExclusive(async () => {
			const normalized = normalizeVaultPath(path);
			if (!normalized) {
				throw new Error(t('Empty file path.', 'Пустой путь файла.'));
			}
			const metadata: FileMetadata = {
				path: normalized,
				sha256,
				mtime,
				size,
				status: 'active',
				lastModifiedDevice: deviceName ?? this.deviceName,
			};
			this.manifest.files[normalized] = metadata;
			if (persist) {
				await this.saveNow();
			} else {
				this.scheduleSave();
			}
			return copyMetadata(metadata);
		});
	}

	readBinary(path: string): Promise<ArrayBuffer | null> {
		return this.readBinarySafe(normalizeVaultPath(path));
	}

	stat(path: string): Promise<Stat | null> {
		return this.statSafe(normalizeVaultPath(path));
	}

	async writeBinaryFile(path: string, data: ArrayBuffer): Promise<Stat | null> {
		const normalized = normalizeVaultPath(path);
		if (!normalized) {
			throw new Error(t('Empty file path.', 'Пустой путь файла.'));
		}
		const vault = this.host.app.vault;
		const existing = vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await vault.modifyBinary(existing, data);
		} else if (existing) {
			throw new Error(
				t(
					'Cannot write “{path}”: a folder exists at that path.',
					'Не удалось записать «{path}»: по этому пути находится папка.',
					{ path: normalized },
				),
			);
		} else {
			const parent = parentFolder(normalized);
			if (parent) {
				await this.ensureVaultFolder(parent);
			}
			try {
				await vault.createBinary(normalized, data);
			} catch (error) {
				const raced = vault.getAbstractFileByPath(normalized);
				if (raced instanceof TFile) {
					await vault.modifyBinary(raced, data);
				} else {
					throw new Error(
						t(
							'Could not write “{path}”: {error}',
							'Не удалось записать «{path}»: {error}',
							{ path: normalized, error: errorMessage(error) },
						),
					);
				}
			}
		}
		return this.statSafe(normalized);
	}

	async removeLocal(path: string): Promise<void> {
		const normalized = normalizeVaultPath(path);
		if (!normalized) {
			return;
		}
		const vault = this.host.app.vault;
		const file = vault.getAbstractFileByPath(normalized);
		if (!file) {
			return;
		}
		if (!(file instanceof TFile)) {
			throw new Error(
				t(
					'Expected a file at “{path}”.',
					'Ожидался файл по пути «{path}».',
					{ path: normalized },
				),
			);
		}
		try {
			await vault.delete(file);
		} catch (error) {
			if (vault.getAbstractFileByPath(normalized)) {
				throw new Error(
					t(
						'Could not delete “{path}”: {error}',
						'Не удалось удалить файл «{path}»: {error}',
						{ path: normalized, error: errorMessage(error) },
					),
				);
			}
		}
	}

	purgeTombstones(): Promise<number> {
		return this.runExclusive(async () => {
			let removed = 0;
			for (const [path, metadata] of Object.entries(this.manifest.files)) {
				if (metadata.status === 'deleted_tombstone') {
					delete this.manifest.files[path];
					removed += 1;
				}
			}
			if (removed > 0) {
				await this.saveNow();
			}
			return removed;
		});
	}

	private createEmptyManifest(): VaultManifest {
		return {
			schemaVersion: MANIFEST_SCHEMA_VERSION,
			deviceId: this.host.getDeviceId(),
			deviceName: this.host.getDeviceName(),
			updatedAt: Date.now(),
			files: createFileMap(),
		};
	}

	private runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private isIgnored(path: string): boolean {
		return isPathIgnored(path, this.host.app.vault.configDir, this.host.getSettings().excludedFolders);
	}

	private async statSafe(path: string): Promise<Stat | null> {
		if (!path) {
			return null;
		}
		const file = this.host.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return {
				type: 'file',
				ctime: file.stat.ctime,
				mtime: file.stat.mtime,
				size: file.stat.size,
			};
		}
		if (file instanceof TFolder) {
			return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
		}
		return null;
	}

	/**
	 * В обычной работе используем уже проиндексированный TFile.stat: это избавляет
	 * от десятков тысяч обращений через мост Capacitor на мобильном. Если stat
	 * почему-то отсутствует — идём в Vault API через getAbstractFileByPath.
	 */
	private statForFile(file: TFile): Promise<Stat | null> {
		const cached = file.stat;
		if (cached && typeof cached.mtime === 'number' && typeof cached.size === 'number') {
			return Promise.resolve({
				type: 'file',
				ctime: cached.ctime,
				mtime: cached.mtime,
				size: cached.size,
			});
		}
		return this.statSafe(normalizeVaultPath(file.path));
	}

	private async readBinarySafe(path: string): Promise<ArrayBuffer | null> {
		if (!path) {
			return null;
		}
		const file = this.host.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return null;
		}
		try {
			return await this.host.app.vault.readBinary(file);
		} catch (error) {
			warnLog(`Failed to read “${path}”`, error);
			return null;
		}
	}

	private async refreshPathInternal(path: string): Promise<FileMetadata | null> {
		const normalized = normalizeVaultPath(path);
		if (!normalized || this.isIgnored(normalized)) {
			return null;
		}
		const stat = await this.statSafe(normalized);
		if (!stat || stat.type !== 'file') {
			return null;
		}
		const maxBytes = this.host.getSettings().maxFileSizeMb * 1024 * 1024;
		if (stat.size > maxBytes) {
			if (this.manifest.files[normalized]) {
				delete this.manifest.files[normalized];
				this.scheduleSave();
			}
			return null;
		}
		const existing = this.manifest.files[normalized];
		const unchanged = existing
			&& existing.status === 'active'
			&& existing.mtime === stat.mtime
			&& existing.size === stat.size;
		if (unchanged) {
			return copyMetadata(existing);
		}
		const data = await this.readBinarySafe(normalized);
		if (!data) {
			return null;
		}
		const sha256 = await sha256Hex(data);
		const device = existing && existing.sha256 === sha256
			? existing.lastModifiedDevice
			: this.deviceName;
		const metadata: FileMetadata = {
			path: normalized,
			sha256,
			mtime: stat.mtime,
			size: stat.size,
			status: 'active',
			lastModifiedDevice: device || this.deviceName,
		};
		this.manifest.files[normalized] = metadata;
		this.scheduleSave();
		return copyMetadata(metadata);
	}

	private async refreshPrefix(prefix: string): Promise<void> {
		const files = this.host.app.vault.getFiles();
		for (const file of files) {
			const path = normalizeVaultPath(file.path);
			if (path === prefix || path.startsWith(`${prefix}/`)) {
				await this.refreshPathInternal(path);
			}
		}
	}

	private tombstonePathInternal(path: string): void {
		const metadata = this.manifest.files[path];
		if (!metadata) {
			return;
		}
		if (metadata.status === 'active') {
			metadata.status = 'deleted_tombstone';
			metadata.deletedAt = Date.now();
			metadata.lastModifiedDevice = this.deviceName;
			this.scheduleSave();
		}
	}

	private tombstoneFolderInternal(prefix: string): void {
		const needle = `${prefix}/`;
		for (const [path, metadata] of Object.entries(this.manifest.files)) {
			if (metadata.status !== 'active') {
				continue;
			}
			if (path === prefix || path.startsWith(needle)) {
				metadata.status = 'deleted_tombstone';
				metadata.deletedAt = Date.now();
				metadata.lastModifiedDevice = this.deviceName;
			}
		}
		this.scheduleSave();
	}

	private scheduleRefresh(path: string): void {
		if (!path || this.isIgnored(path)) {
			return;
		}
		this.pendingRefresh.add(path);
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			const paths = Array.from(this.pendingRefresh);
			this.pendingRefresh.clear();
			if (paths.length === 0) {
				return;
			}
			void this.runExclusive(async () => {
				for (const pending of paths) {
					try {
						await this.refreshPathInternal(pending);
					} catch (error) {
						errorLog(`Failed to refresh “${pending}”`, error);
					}
				}
			});
		}, 1200);
	}

	private async ensureVaultFolder(path: string): Promise<void> {
		const vault = this.host.app.vault;
		const segments = path.split('/').filter((segment) => segment.length > 0);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			const existing = vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) {
				continue;
			}
			if (existing) {
				throw new Error(
					t(
						'Cannot create folder “{path}”: a file exists at that path.',
						'Не удалось создать папку «{path}»: по этому пути находится файл.',
						{ path: current },
					),
				);
			}
			try {
				await vault.createFolder(current);
			} catch (error) {
				const after = vault.getAbstractFileByPath(current);
				if (!(after instanceof TFolder)) {
					throw new Error(
						t(
							'Could not create folder “{path}”: {error}',
							'Не удалось создать папку «{path}»: {error}',
							{ path: current, error: errorMessage(error) },
						),
					);
				}
			}
		}
	}

	private async ensureManifestFolder(path: string): Promise<void> {
		if (!path) {
			return;
		}
		const adapter = this.host.app.vault.adapter;
		const segments = path.split('/').filter((segment) => segment.length > 0);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (await adapter.exists(current)) {
				continue;
			}
			try {
				await adapter.mkdir(current);
			} catch (error) {
				if (!(await adapter.exists(current))) {
					throw new Error(
						t(
							'Could not create folder “{path}”: {error}',
							'Не удалось создать папку «{path}»: {error}',
							{ path: current, error: errorMessage(error) },
						),
					);
				}
			}
		}
	}

	private async quarantineCorrupt(path: string): Promise<void> {
		try {
			await this.host.app.vault.adapter.rename(path, `${path}.corrupt-${Date.now()}`);
		} catch (error) {
			warnLog('Failed to keep a copy of the corrupted manifest.', error);
		}
	}
}
