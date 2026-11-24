import { Notice, Platform, Plugin } from 'obsidian';
import type { LanSyncSettings, PingResponse, SyncHost } from './types';
import { DEFAULT_SERVER_PORT, DEFAULT_SETTINGS } from './types';
import { ManifestManager } from './manifest';
import { DesktopSyncServer } from './server';
import { SyncClient } from './client';
import { LanSyncSettingTab } from './settings';
import { SyncReviewModal } from './ui/SyncReviewModal';
import { setUiLanguage, t } from './i18n';
import { debugLog, errorLog, setDebugLogging } from './logger';
import {
	connectionJson,
	copyText,
	createDeviceId,
	detectLocalAddresses,
	errorMessage,
	randomHex,
} from './utils';

export default class LanSyncPlugin extends Plugin implements SyncHost {
	override settings: LanSyncSettings = { ...DEFAULT_SETTINGS };
	manager!: ManifestManager;
	server: DesktopSyncServer | null = null;

	private statusBarEl: HTMLElement | null = null;
	private syncClient: SyncClient | null = null;
	private syncing = false;
	private restartTimer: number | null = null;
	private unloaded = false;

	override async onload(): Promise<void> {
		await this.loadSettings();
		setUiLanguage(this.settings.uiLanguage);
		setDebugLogging(this.settings.debugLogging);

		this.manager = new ManifestManager(this);
		await this.manager.load();

		this.addSettingTab(new LanSyncSettingTab(this.app, this));
		this.registerCommands();

		this.statusBarEl = this.addStatusBarItem() ?? null;
		if (this.statusBarEl) {
			this.statusBarEl.addClass('lan-sync-status');
			this.registerDomEvent(this.statusBarEl, 'click', () => {
				void this.runSync();
			});
		}
		this.updateStatusBar();

		this.addRibbonIcon(
			'refresh-cw',
			t(
				'LAN Vault Bridge: sync vault',
				'LAN Vault Bridge: синхронизировать хранилище',
			),
			() => {
				void this.runSync();
			},
		);

		// Subscribe to vault events only after the workspace is ready;
		// otherwise Obsidian emits a burst of create/modify events at startup.
		this.app.workspace.onLayoutReady(() => {
			void this.handleLayoutReady();
		});

		if (Platform.isDesktop && this.settings.serverEnabled) {
			void this.startServer();
		}
	}

	override onunload(): void {
		this.unloaded = true;
		if (this.restartTimer !== null) {
			window.clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		void this.stopServer();
		if (this.manager) {
			this.manager.flush();
		}
	}

	getSettings(): LanSyncSettings {
		return this.settings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		setUiLanguage(this.settings.uiLanguage);
		setDebugLogging(this.settings.debugLogging);
		this.updateStatusBar();
	}

	getDeviceId(): string {
		return this.settings.deviceId;
	}

	getDeviceName(): string {
		return this.settings.deviceName || this.defaultDeviceName();
	}

	pingServer(): Promise<PingResponse> {
		return this.getClient().ping();
	}

	openSettings(): void {
		const setting = (
			this.app as unknown as {
				setting?: { open(): void; openTabById(id: string): void };
			}
		).setting;
		if (!setting) {
			return;
		}
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	async startServer(): Promise<void> {
		if (!Platform.isDesktop || this.unloaded) {
			return;
		}
		await this.stopServer();
		const server = new DesktopSyncServer(
			this.app,
			this.manager,
			() => this.settings,
			this.manifest.version,
		);
		try {
			const port = await server.start();
			this.server = server;
			debugLog(`LAN server started on 0.0.0.0:${port}`);
		} catch (error) {
			this.server = null;
			errorLog('Failed to start the LAN server.', error);
			new Notice(
				t('LAN Vault Bridge: {error}', 'LAN Vault Bridge: {error}', {
					error: errorMessage(error),
				}),
				12000,
			);
		}
		this.updateStatusBar();
	}

	async stopServer(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) {
			await server.stop();
		}
		this.updateStatusBar();
	}

	async restartServer(): Promise<void> {
		await this.stopServer();
		if (this.settings.serverEnabled) {
			await this.startServer();
		}
	}

	scheduleServerRestart(): void {
		if (!Platform.isDesktop) {
			return;
		}
		if (this.restartTimer !== null) {
			window.clearTimeout(this.restartTimer);
		}
		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			void this.restartServer();
		}, 800);
	}

	async runSync(): Promise<void> {
		if (this.syncing) {
			new Notice(t('Sync is already running.', 'Синхронизация уже выполняется.'));
			return;
		}
		if (!this.settings.clientHost.trim()) {
			new Notice(
				Platform.isMobile
					? t(
							'Enter the desktop IP in LAN Vault Bridge settings or import a connection string.',
							'Укажите IP ПК в настройках LAN Vault Bridge или импортируйте строку подключения.',
						)
					: t(
							'Enter the desktop address in the Client section of LAN Vault Bridge settings.',
							'Укажите адрес ПК в разделе «Клиент» настроек LAN Vault Bridge.',
						),
				8000,
			);
			this.openSettings();
			return;
		}

		this.syncing = true;
		this.updateStatusBar();
		const progress = new Notice(t('Scanning the vault…', 'Сканирование хранилища…'), 0);
		try {
			await this.manager.reconcile((scanned, total) => {
				if (total > 0 && (scanned === total || scanned % 100 === 0)) {
					progress.setMessage(
						t(
							'Scanning the vault: {done}/{total}',
							'Сканирование хранилища: {done}/{total}',
							{ done: scanned, total },
						),
					);
				}
			});
			progress.setMessage(t('Comparing with the desktop…', 'Сравнение с ПК…'));
			const diff = await this.getClient().fetchDiff(this.manager.snapshot());
			progress.hide();

			if (diff.fileConflicts.length === 0 && diff.contentDiffs.length === 0) {
				new Notice(
					t(
						'Vaults are identical: no changes found',
						'Хранилища идентичны: изменений не обнаружено',
					),
				);
				return;
			}
			new SyncReviewModal(this.app, this, diff).open();
		} catch (error) {
			progress.hide();
			errorLog('Sync failed.', error);
			new Notice(
				t('LAN Vault Bridge: {error}', 'LAN Vault Bridge: {error}', {
					error: errorMessage(error),
				}),
				12000,
			);
		} finally {
			this.syncing = false;
			this.updateStatusBar();
		}
	}

	/** Uploads a local file to the desktop and records the new state in the manifest. */
	async uploadPath(path: string): Promise<void> {
		const data = await this.manager.readBinary(path);
		if (!data) {
			throw new Error(
				t(
					'File “{path}” was not found on this device.',
					'Файл «{path}» не найден на этом устройстве.',
					{ path },
				),
			);
		}
		const metadata = await this.getClient().uploadFile(path, data, this.getDeviceName());
		const stat = await this.manager.stat(path);
		await this.manager.recordFileState(
			path,
			metadata.sha256,
			stat?.mtime ?? Date.now(),
			data.byteLength,
			this.getDeviceName(),
		);
	}

	/** Downloads a file from the desktop and records its state in the manifest. */
	async downloadPath(path: string): Promise<void> {
		const downloaded = await this.getClient().downloadFile(path);
		const stat = await this.manager.writeBinaryFile(path, downloaded.data);
		await this.manager.recordFileState(
			path,
			downloaded.sha256,
			stat?.mtime ?? downloaded.mtime ?? Date.now(),
			downloaded.size,
			this.getDeviceName(),
		);
	}

	/** Deletes the file on the phone and the desktop; both sides get a tombstone. */
	async deleteEverywhere(path: string): Promise<void> {
		await this.getClient().tombstoneFile(path, this.getDeviceName());
		await this.manager.removeLocal(path);
		await this.manager.markTombstone(path, this.getDeviceName(), true);
	}

	readLocalBinary(path: string): Promise<ArrayBuffer | null> {
		return this.manager.readBinary(path);
	}

	async readServerBinary(path: string): Promise<ArrayBuffer> {
		const downloaded = await this.getClient().downloadFile(path);
		return downloaded.data;
	}

	private getClient(): SyncClient {
		if (!this.syncClient) {
			this.syncClient = new SyncClient(() => this.settings);
		}
		return this.syncClient;
	}

	private async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<LanSyncSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
		this.settings.excludedFolders = Array.isArray(this.settings.excludedFolders)
			? this.settings.excludedFolders
					.filter((value): value is string => typeof value === 'string')
					.map((value) => value.trim())
					.filter((value) => value.length > 0)
			: [];
		if (!this.settings.deviceId) {
			this.settings.deviceId = createDeviceId();
		}
		if (!this.settings.deviceName) {
			this.settings.deviceName = this.defaultDeviceName();
		}
		if (this.settings.uiLanguage !== 'auto' && this.settings.uiLanguage !== 'en' && this.settings.uiLanguage !== 'ru') {
			this.settings.uiLanguage = 'auto';
		}
		if (typeof this.settings.debugLogging !== 'boolean') {
			this.settings.debugLogging = false;
		}
		if (!this.settings.authToken) {
			this.settings.authToken = randomHex(16);
		}
		if (!Number.isFinite(this.settings.serverPort)) {
			this.settings.serverPort = DEFAULT_SERVER_PORT;
		}
		if (!Number.isFinite(this.settings.clientPort)) {
			this.settings.clientPort = DEFAULT_SERVER_PORT;
		}
		if (!Number.isFinite(this.settings.requestTimeoutMs)) {
			this.settings.requestTimeoutMs = DEFAULT_SETTINGS.requestTimeoutMs;
		}
		if (!Number.isFinite(this.settings.maxFileSizeMb)) {
			this.settings.maxFileSizeMb = DEFAULT_SETTINGS.maxFileSizeMb;
		}
		if (
			!Number.isInteger(this.settings.parallelTransfers)
			|| this.settings.parallelTransfers < 1
			|| this.settings.parallelTransfers > 6
		) {
			this.settings.parallelTransfers = DEFAULT_SETTINGS.parallelTransfers;
		}
		await this.saveSettings();
	}

	private defaultDeviceName(): string {
		if (Platform.isAndroidApp) {
			return 'Android';
		}
		if (Platform.isIosApp) {
			return 'iPhone/iPad';
		}
		if (Platform.isMacOS) {
			return 'macOS';
		}
		if (Platform.isWin) {
			return 'Windows';
		}
		if (Platform.isLinux) {
			return 'Linux';
		}
		return 'Obsidian';
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: t('Sync now', 'Синхронизировать сейчас'),
			callback: () => {
				void this.runSync();
			},
		});
		this.addCommand({
			id: 'ping-server',
			name: t('Test connection to desktop', 'Проверить соединение с ПК'),
			callback: () => {
				void this.testConnection();
			},
		});
		this.addCommand({
			id: 'restart-server',
			name: t('Restart LAN server', 'Перезапустить LAN-сервер'),
			checkCallback: (checking) => {
				if (!Platform.isDesktop) {
					return false;
				}
				if (!checking) {
					void this.restartServer();
				}
				return true;
			},
		});
		this.addCommand({
			id: 'copy-connection',
			name: t('Copy connection string (JSON)', 'Скопировать строку подключения (JSON)'),
			checkCallback: (checking) => {
				if (!Platform.isDesktop) {
					return false;
				}
				if (!checking) {
					void this.copyConnectionString();
				}
				return true;
			},
		});
	}

	private async testConnection(): Promise<void> {
		try {
			const ping = await this.pingServer();
			new Notice(
				t(
					'LAN Vault Bridge: connected to “{device}” (v{version})',
					'LAN Vault Bridge: подключено к «{device}» (v{version})',
					{ device: ping.deviceName, version: ping.version },
				),
			);
		} catch (error) {
			new Notice(
				t('LAN Vault Bridge: {error}', 'LAN Vault Bridge: {error}', {
					error: errorMessage(error),
				}),
				10000,
			);
		}
	}

	private async copyConnectionString(): Promise<void> {
		const addresses = detectLocalAddresses();
		if (addresses.length === 0) {
			new Notice(
				t(
					'Could not determine the external IPv4 address of this desktop.',
					'Не удалось определить внешний IPv4-адрес этого ПК.',
				),
				8000,
			);
			return;
		}
		const json = connectionJson(
			addresses[0].address,
			this.settings.serverPort,
			this.settings.authToken,
		);
		const copied = await copyText(json);
		new Notice(
			copied
				? t(
						'Connection string copied ({host}:{port}).',
						'Строка подключения скопирована ({host}:{port}).',
						{ host: addresses[0].address, port: this.settings.serverPort },
					)
				: t(
						'Could not copy the connection string.',
						'Не удалось скопировать строку подключения.',
					),
		);
	}

	private async handleLayoutReady(): Promise<void> {
		if (this.unloaded) {
			return;
		}
		this.registerVaultEvents();
		try {
			await this.manager.reconcile();
		} catch (error) {
			errorLog('Initial manifest reconciliation failed.', error);
		}
		this.updateStatusBar();
	}

	private registerVaultEvents(): void {
		const vault = this.app.vault;
		this.registerEvent(
			vault.on('create', (file) => {
				void this.manager.handleCreate(file).catch((error: unknown) => {
					errorLog('vault.create failed.', error);
				});
			}),
		);
		this.registerEvent(
			vault.on('modify', (file) => {
				void this.manager.handleModify(file).catch((error: unknown) => {
					errorLog('vault.modify failed.', error);
				});
			}),
		);
		this.registerEvent(
			vault.on('delete', (file) => {
				void this.manager.handleDelete(file).catch((error: unknown) => {
					errorLog('vault delete event failed.', error);
				});
			}),
		);
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				void this.manager.handleRename(file, oldPath).catch((error: unknown) => {
					errorLog('vault.rename failed.', error);
				});
			}),
		);
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) {
			return;
		}
		let text: string;
		if (this.syncing) {
			text = t('LAN: syncing…', 'LAN: синхронизация…');
		} else if (Platform.isDesktop) {
			if (this.server?.isRunning) {
				text = t('LAN: server :{port}', 'LAN: сервер :{port}', {
					port: this.server.getPort(),
				});
			} else if (this.settings.serverEnabled) {
				text = t('LAN: server not running', 'LAN: сервер не запущен');
			} else {
				text = t('LAN: server off', 'LAN: сервер выкл.');
			}
		} else {
			text = this.settings.clientHost
				? `LAN: ${this.settings.clientHost}`
				: t('LAN: not configured', 'LAN: не настроен');
		}
		this.statusBarEl.setText(text);
		this.statusBarEl.setAttribute(
			'title',
			t(
				'LAN Vault Bridge — click to sync',
				'LAN Vault Bridge — нажмите, чтобы синхронизировать',
			),
		);
	}
}
