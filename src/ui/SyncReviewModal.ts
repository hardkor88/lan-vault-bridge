import type { App } from 'obsidian';
import { Modal, Notice, setIcon } from 'obsidian';
import { diffWordsWithSpace } from 'diff';
import type { ConflictReason, ContentDiff, FileConflict, FileMetadata, SyncDiff } from '../types';
import type LanSyncPlugin from '../main';
import {
	decodeUtf8,
	errorMessage,
	formatBytes,
	formatTimestamp,
	getImageMime,
	isImagePath,
	isTextPath,
} from '../utils';
import { confirmAction } from './ConfirmModal';
import { confirmDeletionWithPreview, type DeleteDecision } from './DeletePreviewModal';
import { t } from '../i18n';

/** Больше этого не показываем в <pre> и не диффим — чтобы не вешать мобильный WebView. */
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_DIFF_TEXT_CHARS = 250_000;
const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;

type CardStatus = 'pending' | 'done' | 'skipped';
type BulkMode = 'default' | 'pull' | 'push';
type BulkAction = 'upload' | 'download' | 'delete';

interface BaseView {
	path: string;
	details: HTMLDetailsElement;
	bodyEl: HTMLElement;
	previewEl: HTMLElement;
	actionsEl: HTMLElement;
	stateEl: HTMLElement;
	objectUrls: string[];
	localData?: ArrayBuffer;
	serverData?: ArrayBuffer;
	status: CardStatus;
	loaded: boolean;
	busy: boolean;
}

interface ConflictView extends BaseView {
	conflict: FileConflict;
}

interface ContentView extends BaseView {
	diff: ContentDiff;
}

type AnyView = ConflictView | ContentView;

interface Deal {
	view: AnyView;
	action: BulkAction;
}

function badgeFor(reason: ConflictReason): { label: string; cls: string } {
	switch (reason) {
		case 'only_on_client':
			return {
				label: t('On phone only', 'Только на телефоне'),
				cls: 'lan-sync-badge--warning',
			};
		case 'only_on_server':
			return {
				label: t('On desktop only', 'Только на ПК'),
				cls: 'lan-sync-badge--warning',
			};
		case 'deleted_on_server':
			return {
				label: t('Deleted on desktop', 'Удалён на ПК'),
				cls: 'lan-sync-badge--error',
			};
		case 'deleted_on_client':
			return {
				label: t('Deleted on phone', 'Удалён на телефоне'),
				cls: 'lan-sync-badge--error',
			};
		case 'modified_after_server_delete':
			return {
				label: t(
					'Deleted on desktop, changed on phone',
					'Удалён на ПК, изменён на телефоне',
				),
				cls: 'lan-sync-badge--accent',
			};
		case 'modified_after_client_delete':
			return {
				label: t(
					'Deleted on phone, changed on desktop',
					'Удалён на телефоне, изменён на ПК',
				),
				cls: 'lan-sync-badge--accent',
			};
	}
}

/**
 * Выбор «по умолчанию». Плагин приоритизирует сохранность данных:
 * удаления не тиражируются молча — файл предлагается восстановить.
 */
function defaultActionFor(reason: ConflictReason): 'upload' | 'download' {
	switch (reason) {
		case 'only_on_client':
			return 'upload';
		case 'only_on_server':
			return 'download';
		case 'deleted_on_server':
			return 'upload';
		case 'deleted_on_client':
			return 'download';
		case 'modified_after_server_delete':
			return 'upload';
		case 'modified_after_client_delete':
			return 'download';
	}
}

export class SyncReviewModal extends Modal {
	private readonly plugin: LanSyncPlugin;
	private readonly diff: SyncDiff;
	private readonly conflictViews: ConflictView[] = [];
	private readonly contentViews: ContentView[] = [];
	private readonly bulkButtons: HTMLButtonElement[] = [];
	private footerCountEl: HTMLElement | null = null;
	private progressEl: HTMLElement | null = null;
	private closeButton: HTMLButtonElement | null = null;
	private bulkRunning = false;
	private closed = false;
	private completionAnnounced = false;

	constructor(app: App, plugin: LanSyncPlugin, diff: SyncDiff) {
		super(app);
		this.plugin = plugin;
		this.diff = diff;
	}

	override onOpen(): void {
		this.modalEl.addClass('lan-sync-modal-container');
		this.contentEl.addClass('lan-sync-modal');
		this.titleEl.setText(t('Sync review', 'Синхронизация LAN'));

		const intro = this.contentEl.createDiv({ cls: 'lan-sync-intro' });
		intro.createEl('p', {
			text: t(
				'Desktop: {server} · this device: {device}',
				'ПК: {server} · это устройство: {device}',
				{
					server: this.diff.serverDeviceName,
					device: this.plugin.getDeviceName(),
				},
			),
		});
		intro.createEl('p', {
			cls: 'lan-sync-hint',
			text: t(
				'By default the plugin preserves data: deleted files are offered for restore, and for changed files the newer version wins.',
				'По умолчанию плагин сохраняет данные: удалённые файлы предлагается восстановить, для изменённых побеждает более свежая версия.',
			),
		});

		this.renderTwoWayToolbar();
		this.renderConflictSection();
		this.renderContentSection();
		this.renderFooter();
		this.updateCounter();
	}

	private renderTwoWayToolbar(): void {
		const toolbar = this.contentEl.createDiv({ cls: 'lan-sync-two-way' });
		const button = toolbar.createEl('button', {
			cls: 'lan-sync-two-way-button mod-cta',
		});
		const icon = button.createSpan({ cls: 'lan-sync-two-way-icon' });
		setIcon(icon, 'arrow-left-right');
		button.createSpan({ text: t('Send to both devices', 'Отправить на оба устройства') });
		button.addEventListener('click', () => {
			if (this.closed || this.bulkRunning) {
				return;
			}
			void this.applyTwoWay();
		});
		toolbar.createDiv({
			cls: 'lan-sync-hint',
			text: t(
				'Phone → desktop and desktop → phone at the same time. Deletions are confirmed with a content preview; identical files use the newer version.',
				'Телефон → ПК и ПК → телефон одновременно. Удаления подтверждаются с показом содержимого; для одинаковых файлов побеждает более новая версия.',
			),
		});
	}

	override onClose(): void {
		this.closed = true;
		for (const view of [...this.conflictViews, ...this.contentViews]) {
			for (const url of view.objectUrls) {
				URL.revokeObjectURL(url);
			}
			view.objectUrls.length = 0;
		}
		this.contentEl.empty();
	}

	private renderConflictSection(): void {
		if (this.diff.fileConflicts.length === 0) {
			return;
		}
		const section = this.createSection(
			t('File presence', 'Наличие файлов'),
			this.diff.fileConflicts.length,
		);
		this.addBulkButton(
			section.bulk,
			t('Apply defaults to all', 'Применить выбранное по умолчанию ко всем'),
			() => {
				void this.applyBulkConflicts('default');
			},
		);
		this.addBulkButton(section.bulk, t('Accept all from desktop', 'Принять все с ПК'), () => {
			void this.applyBulkConflicts('pull');
		});
		this.addBulkButton(section.bulk, t('Send all to desktop', 'Отправить все на ПК'), () => {
			void this.applyBulkConflicts('push');
		});
		const list = section.section.createDiv({ cls: 'lan-sync-list' });
		for (const conflict of this.diff.fileConflicts) {
			this.conflictViews.push(this.createConflictCard(list, conflict));
		}
	}

	private renderContentSection(): void {
		if (this.diff.contentDiffs.length === 0) {
			return;
		}
		const section = this.createSection(
			t('Content changes', 'Изменения в тексте и файлах'),
			this.diff.contentDiffs.length,
		);
		this.addBulkButton(
			section.bulk,
			t('Accept all desktop versions', 'Принять все версии с ПК'),
			() => {
				void this.applyBulkContent('pull');
			},
		);
		this.addBulkButton(
			section.bulk,
			t('Send all versions to desktop', 'Отправить все версии на ПК'),
			() => {
				void this.applyBulkContent('push');
			},
		);
		const list = section.section.createDiv({ cls: 'lan-sync-list' });
		for (const diff of this.diff.contentDiffs) {
			this.contentViews.push(this.createContentCard(list, diff));
		}
	}

	private createSection(title: string, count: number): { section: HTMLElement; bulk: HTMLElement } {
		const section = this.contentEl.createEl('section', { cls: 'lan-sync-section' });
		const header = section.createDiv({ cls: 'lan-sync-section-header' });
		const titleWrap = header.createDiv({ cls: 'lan-sync-section-title' });
		titleWrap.createEl('h3', { text: title });
		titleWrap.createSpan({ cls: 'lan-sync-count', text: String(count) });
		const bulk = header.createDiv({ cls: 'lan-sync-bulk' });
		return { section, bulk };
	}

	private addBulkButton(container: HTMLElement, label: string, handler: () => void): void {
		const button = container.createEl('button', { cls: 'lan-sync-bulk-button', text: label });
		button.addEventListener('click', () => {
			if (this.bulkRunning) {
				return;
			}
			handler();
		});
		this.bulkButtons.push(button);
	}

	private createConflictCard(list: HTMLElement, conflict: FileConflict): ConflictView {
		const badge = badgeFor(conflict.reason);
		const details = list.createEl('details', { cls: 'lan-sync-card' });
		const summary = details.createEl('summary', { cls: 'lan-sync-summary' });
		const chevron = summary.createSpan({ cls: 'lan-sync-chevron' });
		setIcon(chevron, 'chevron-right');
		const pathEl = summary.createSpan({ cls: 'lan-sync-path', text: conflict.path });
		pathEl.setAttribute('title', conflict.path);
		summary.createSpan({ cls: `lan-sync-badge ${badge.cls}`, text: badge.label });
		const stateEl = summary.createSpan({ cls: 'lan-sync-state' });

		const bodyEl = details.createDiv({ cls: 'lan-sync-card-body' });
		this.renderMetaGrid(bodyEl, conflict.client, conflict.server);
		const previewEl = bodyEl.createDiv({ cls: 'lan-sync-preview' });
		const actionsEl = bodyEl.createDiv({ cls: 'lan-sync-actions' });

		const view: ConflictView = {
			path: conflict.path,
			conflict,
			details,
			bodyEl,
			previewEl,
			actionsEl,
			stateEl,
			objectUrls: [],
			status: 'pending',
			loaded: false,
			busy: false,
		};
		this.renderConflictActions(view);
		details.addEventListener('toggle', () => {
			if (details.open) {
				void this.loadConflictPreview(view);
			}
		});
		return view;
	}

	private createContentCard(list: HTMLElement, diff: ContentDiff): ContentView {
		const details = list.createEl('details', { cls: 'lan-sync-card' });
		const summary = details.createEl('summary', { cls: 'lan-sync-summary' });
		const chevron = summary.createSpan({ cls: 'lan-sync-chevron' });
		setIcon(chevron, 'chevron-right');
		const pathEl = summary.createSpan({ cls: 'lan-sync-path', text: diff.path });
		pathEl.setAttribute('title', diff.path);
		summary.createSpan({
			cls: 'lan-sync-badge lan-sync-badge--accent',
			text: t('Changed', 'Изменён'),
		});
		const stateEl = summary.createSpan({ cls: 'lan-sync-state' });

		const bodyEl = details.createDiv({ cls: 'lan-sync-card-body' });
		this.renderMetaGrid(bodyEl, diff.client, diff.server);
		const previewEl = bodyEl.createDiv({ cls: 'lan-sync-preview' });
		const actionsEl = bodyEl.createDiv({ cls: 'lan-sync-actions' });

		const view: ContentView = {
			path: diff.path,
			diff,
			details,
			bodyEl,
			previewEl,
			actionsEl,
			stateEl,
			objectUrls: [],
			status: 'pending',
			loaded: false,
			busy: false,
		};
		this.renderContentActions(view);
		details.addEventListener('toggle', () => {
			if (details.open) {
				void this.loadContentPreview(view);
			}
		});
		return view;
	}

	private renderMetaGrid(
		container: HTMLElement,
		client: FileMetadata | undefined,
		server: FileMetadata | undefined,
	): void {
		const grid = container.createDiv({ cls: 'lan-sync-meta-grid' });
		this.renderMetaCell(grid, t('Phone', 'Телефон'), client);
		this.renderMetaCell(grid, t('Desktop', 'ПК'), server);
	}

	private renderMetaCell(
		parent: HTMLElement,
		label: string,
		metadata: FileMetadata | undefined,
	): void {
		const cell = parent.createDiv({ cls: 'lan-sync-meta-cell' });
		cell.createDiv({ cls: 'lan-sync-meta-label', text: label });
		if (!metadata) {
			cell.createDiv({ cls: 'lan-sync-meta-value is-muted', text: t('No data', 'Нет данных') });
			return;
		}
		if (metadata.status === 'deleted_tombstone') {
			cell.createDiv({
				cls: 'lan-sync-meta-value is-error',
				text: t('Deleted {date}', 'Удалён {date}', {
					date: formatTimestamp(metadata.deletedAt),
				}),
			});
			return;
		}
		cell.createDiv({
			cls: 'lan-sync-meta-value',
			text: `${formatBytes(metadata.size)} · ${formatTimestamp(metadata.mtime)}`,
		});
	}

	private renderConflictActions(view: ConflictView): void {
		const { conflict } = view;
		const clientActive = conflict.client?.status === 'active';
		const serverActive = conflict.server?.status === 'active';
		if (clientActive) {
			const label = conflict.server?.status === 'deleted_tombstone'
				? t('Restore on desktop', 'Восстановить на ПК')
				: t('Send to desktop', 'Отправить на ПК');
			this.addActionButton(view, label, 'mod-cta', () => {
				void this.runUpload(view);
			});
		}
		if (serverActive) {
			const label = conflict.client?.status === 'deleted_tombstone'
				? t('Restore on phone', 'Восстановить на телефоне')
				: t('Download to phone', 'Скачать на телефон');
			this.addActionButton(view, label, 'mod-cta', () => {
				void this.runDownload(view);
			});
		}
		this.addActionButton(view, t('Delete everywhere', 'Удалить везде'), 'mod-warning', () => {
			void this.confirmDelete(view);
		});
		this.addActionButton(view, t('Skip', 'Пропустить'), '', () => {
			this.skip(view);
		});
	}

	private renderContentActions(view: ContentView): void {
		this.addActionButton(
			view,
			t('Send phone version to desktop', 'Отправить версию телефона на ПК'),
			'mod-cta',
			() => {
				void this.runUpload(view);
			},
		);
		this.addActionButton(
			view,
			t('Accept desktop version', 'Принять версию с ПК'),
			'mod-cta',
			() => {
				void this.runDownload(view);
			},
		);
		this.addActionButton(view, t('Skip', 'Пропустить'), '', () => {
			this.skip(view);
		});
	}

	private addActionButton(
		view: AnyView,
		label: string,
		variant: string,
		handler: () => void,
	): void {
		const button = view.actionsEl.createEl('button', {
			cls: variant ? `lan-sync-action ${variant}` : 'lan-sync-action',
			text: label,
		});
		button.addEventListener('click', () => {
			if (this.bulkRunning || view.busy || view.status !== 'pending') {
				return;
			}
			handler();
		});
	}

	private async loadConflictPreview(view: ConflictView): Promise<void> {
		if (view.loaded || this.closed) {
			return;
		}
		view.loaded = true;
		view.previewEl.empty();
		const loading = view.previewEl.createDiv({
			cls: 'lan-sync-loading',
			text: t('Loading content…', 'Загрузка содержимого…'),
		});
		try {
			const { conflict } = view;
			const previewLimit = isTextPath(view.path)
				? MAX_TEXT_PREVIEW_BYTES
				: MAX_IMAGE_PREVIEW_BYTES;
			if (
				conflict.client?.status === 'active'
				&& conflict.client.size <= previewLimit
			) {
				view.localData = (await this.plugin.readLocalBinary(view.path)) ?? undefined;
			}
			if (
				conflict.server?.status === 'active'
				&& conflict.server.size <= previewLimit
			) {
				try {
					view.serverData = await this.plugin.readServerBinary(view.path);
				} catch (error) {
					view.previewEl.createDiv({
						cls: 'lan-sync-warning',
						text: t(
							'Could not load the desktop version: {error}',
							'Не удалось загрузить версию с ПК: {error}',
							{ error: errorMessage(error) },
						),
					});
				}
			}
			loading.remove();
			this.renderConflictPreview(view);
		} catch (error) {
			loading.setText(
				t('Could not load: {error}', 'Не удалось загрузить: {error}', {
					error: errorMessage(error),
				}),
			);
			view.loaded = false;
		}
	}

	private renderConflictPreview(view: ConflictView): void {
		const container = view.previewEl;
		container.empty();
		if (isTextPath(view.path)) {
			let shown = false;
			if (view.localData && view.localData.byteLength <= MAX_TEXT_PREVIEW_BYTES) {
				this.renderTextBlock(
					container,
					t('Phone', 'Телефон'),
					decodeUtf8(view.localData),
				);
				shown = true;
			}
			if (view.serverData && view.serverData.byteLength <= MAX_TEXT_PREVIEW_BYTES) {
				this.renderTextBlock(container, t('Desktop', 'ПК'), decodeUtf8(view.serverData));
				shown = true;
			}
			if (!shown) {
				container.createDiv({
					cls: 'lan-sync-empty',
					text: t(
						'Text is unavailable: the file was deleted or is too large for preview.',
						'Текст недоступен: файл удалён или слишком большой для предпросмотра.',
					),
				});
			}
			return;
		}
		if (isImagePath(view.path)) {
			if (view.localData) {
				this.renderImageBlock(view, t('Phone', 'Телефон'), view.localData);
			}
			if (view.serverData) {
				this.renderImageBlock(view, t('Desktop', 'ПК'), view.serverData);
			}
			if (!view.localData && !view.serverData) {
				container.createDiv({
					cls: 'lan-sync-empty',
					text: t('Preview is unavailable.', 'Превью недоступно.'),
				});
			}
			return;
		}
		container.createDiv({
			cls: 'lan-sync-empty',
			text: t(
				'Binary file: preview is not supported, compare the size and date above.',
				'Бинарный файл: предпросмотр не поддерживается, сравните размер и дату выше.',
			),
		});
	}

	private async loadContentPreview(view: ContentView): Promise<void> {
		if (view.loaded || this.closed) {
			return;
		}
		view.loaded = true;
		view.previewEl.empty();
		const loading = view.previewEl.createDiv({
			cls: 'lan-sync-loading',
			text: t('Loading the desktop version…', 'Загрузка версии с ПК…'),
		});
		try {
			const isText = isTextPath(view.path);
			const previewLimit = isText ? MAX_TEXT_PREVIEW_BYTES : MAX_IMAGE_PREVIEW_BYTES;
			const localTooBig = view.diff.client.size > previewLimit;
			const serverTooBig = view.diff.server.size > previewLimit;
			if (isText && (localTooBig || serverTooBig)) {
				loading.remove();
				view.previewEl.createDiv({
					cls: 'lan-sync-empty',
					text: t(
						'File is larger than {limit}: line-by-line comparison is disabled, use the size and date.',
						'Файл больше {limit}: пофрагментное сравнение отключено, используйте размер и дату.',
						{ limit: formatBytes(MAX_TEXT_PREVIEW_BYTES) },
					),
				});
				return;
			}
			const local = localTooBig ? null : await this.plugin.readLocalBinary(view.path);
			let server: ArrayBuffer | undefined;
			if (!serverTooBig) {
				server = await this.plugin.readServerBinary(view.path);
			}
			view.localData = local ?? undefined;
			view.serverData = server;
			loading.remove();
			if (isText) {
				this.renderTextDiff(view, local, server);
			} else {
				this.renderBinaryDiff(view, local, server);
			}
		} catch (error) {
			loading.setText(
				t('Could not load: {error}', 'Не удалось загрузить: {error}', {
					error: errorMessage(error),
				}),
			);
			view.loaded = false;
		}
	}

	private renderTextDiff(
		view: ContentView,
		local: ArrayBuffer | null,
		server: ArrayBuffer | undefined,
	): void {
		if (!local || !server) {
			view.previewEl.createDiv({
				cls: 'lan-sync-empty',
				text: t(
					'Could not load both file versions for comparison.',
					'Не удалось получить обе версии файла для сравнения.',
				),
			});
			return;
		}
		if (
			local.byteLength > MAX_TEXT_PREVIEW_BYTES
			|| server.byteLength > MAX_TEXT_PREVIEW_BYTES
		) {
			view.previewEl.createDiv({
				cls: 'lan-sync-empty',
				text: t(
					'File is larger than {limit}: line-by-line comparison is disabled, use the size and date.',
					'Файл больше {limit}: пофрагментное сравнение отключено, используйте размер и дату.',
					{ limit: formatBytes(MAX_TEXT_PREVIEW_BYTES) },
				),
			});
			return;
		}
		const pcText = decodeUtf8(server);
		const phoneText = decodeUtf8(local);
		if (pcText.length > MAX_DIFF_TEXT_CHARS || phoneText.length > MAX_DIFF_TEXT_CHARS) {
			view.previewEl.createDiv({
				cls: 'lan-sync-empty',
				text: t(
					'Text is too large for a line-by-line comparison. Choose a version below.',
					'Текст слишком большой для построчного сравнения. Выберите версию кнопками ниже.',
				),
			});
			return;
		}
		const legend = view.previewEl.createDiv({ cls: 'lan-sync-legend' });
		legend.createSpan({
			cls: 'sync-diff-added',
			text: t('added on phone', 'добавлено на телефоне'),
		});
		legend.appendText(' · ');
		legend.createSpan({
			cls: 'sync-diff-removed',
			text: t('removed on phone (exists on desktop)', 'удалено на телефоне (есть на ПК)'),
		});

		const pre = view.previewEl.createEl('pre', { cls: 'lan-sync-diff' });
		const parts = diffWordsWithSpace(pcText, phoneText);
		for (const part of parts) {
			if (part.added) {
				pre.createSpan({ cls: 'sync-diff-added', text: part.value });
			} else if (part.removed) {
				pre.createSpan({ cls: 'sync-diff-removed', text: part.value });
			} else {
				pre.appendText(part.value);
			}
		}
	}

	private renderBinaryDiff(
		view: ContentView,
		local: ArrayBuffer | null,
		server: ArrayBuffer | undefined,
	): void {
		const table = view.previewEl.createEl('table', { cls: 'lan-sync-compare-table' });
		const headRow = table.createEl('thead').createEl('tr');
		headRow.createEl('th', { text: t('Parameter', 'Параметр') });
		headRow.createEl('th', { text: t('Phone', 'Телефон') });
		headRow.createEl('th', { text: t('Desktop', 'ПК') });
		const body = table.createEl('tbody');
		const addRow = (label: string, phone: string, pc: string): void => {
			const row = body.createEl('tr');
			row.createEl('th', { text: label });
			row.createEl('td', { text: phone });
			row.createEl('td', { text: pc });
		};
		addRow(
			t('Size', 'Размер'),
			formatBytes(view.diff.client.size),
			formatBytes(view.diff.server.size),
		);
		addRow(
			t('Modified', 'Дата изменения'),
			formatTimestamp(view.diff.client.mtime),
			formatTimestamp(view.diff.server.mtime),
		);
		addRow('SHA-256', this.shortHash(view.diff.client.sha256), this.shortHash(view.diff.server.sha256));

		if (isImagePath(view.path)) {
			if (local) {
				this.renderImageBlock(view, t('Phone', 'Телефон'), local);
			}
			if (server) {
				this.renderImageBlock(view, t('Desktop', 'ПК'), server);
			}
		} else {
			view.previewEl.createDiv({
				cls: 'lan-sync-empty',
				text: t(
					'Binary file: size, date and checksum are compared. Preview is available only for images.',
					'Бинарный файл: сравниваются размер, дата и контрольная сумма. Превью доступно только для изображений.',
				),
			});
		}
	}

	private shortHash(hash: string): string {
		if (!hash) {
			return '—';
		}
		return hash.length > 16 ? `${hash.slice(0, 16)}…` : hash;
	}

	private renderTextBlock(container: HTMLElement, label: string, text: string): void {
		const block = container.createDiv({ cls: 'lan-sync-preview-block' });
		block.createDiv({ cls: 'lan-sync-preview-label', text: label });
		const pre = block.createEl('pre', { cls: 'lan-sync-text' });
		pre.setText(text);
	}

	private renderImageBlock(view: AnyView, label: string, buffer: ArrayBuffer): void {
		const block = view.previewEl.createDiv({ cls: 'lan-sync-preview-block' });
		block.createDiv({ cls: 'lan-sync-preview-label', text: label });
		const url = URL.createObjectURL(new Blob([buffer], { type: getImageMime(view.path) }));
		view.objectUrls.push(url);
		const image = block.createEl('img', { cls: 'lan-sync-image' });
		image.src = url;
		image.alt = `${label}: ${view.path}`;
	}

	private beginAction(view: AnyView): boolean {
		if (view.busy || view.status !== 'pending' || this.closed) {
			return false;
		}
		view.busy = true;
		view.actionsEl.querySelectorAll('button').forEach((button) => {
			button.disabled = true;
		});
		view.bodyEl.querySelectorAll('.lan-sync-error').forEach((element) => {
			element.remove();
		});
		return true;
	}

	private finishAction(view: AnyView, status: 'done' | 'skipped', label: string): void {
		view.busy = false;
		view.status = status;
		if (this.closed) {
			return;
		}
		view.details.open = false;
		view.details.addClass(status === 'done' ? 'is-done' : 'is-skipped');
		view.stateEl.empty();
		const icon = view.stateEl.createSpan({ cls: 'lan-sync-check' });
		setIcon(icon, status === 'done' ? 'check' : 'minus');
		view.stateEl.createSpan({
			cls: 'lan-sync-state-label',
			text: status === 'done' ? t('Done', 'Выполнено') : t('Skipped', 'Пропущено'),
		});
		view.actionsEl.empty();
		view.actionsEl.createSpan({ cls: 'lan-sync-done-label', text: label });
		this.updateCounter();
	}

	private failAction(view: AnyView, error: unknown): void {
		view.busy = false;
		if (this.closed) {
			return;
		}
		view.actionsEl.querySelectorAll('button').forEach((button) => {
			button.disabled = false;
		});
		const box = view.bodyEl.createDiv({ cls: 'lan-sync-error' });
		box.setText(errorMessage(error));
	}

	private async runUpload(view: AnyView): Promise<void> {
		if (!this.beginAction(view)) {
			return;
		}
		try {
			await this.plugin.uploadPath(view.path);
			this.finishAction(view, 'done', t('Sent to desktop', 'Отправлено на ПК'));
		} catch (error) {
			this.failAction(view, error);
		}
	}

	private async runDownload(view: AnyView): Promise<void> {
		if (!this.beginAction(view)) {
			return;
		}
		try {
			await this.plugin.downloadPath(view.path);
			this.finishAction(view, 'done', t('Received from desktop', 'Получено с ПК'));
		} catch (error) {
			this.failAction(view, error);
		}
	}

	private async confirmDelete(view: ConflictView): Promise<void> {
		if (view.busy || view.status !== 'pending' || this.closed) {
			return;
		}
		const confirmed = await confirmAction(this.app, {
			title: t('Delete the file everywhere?', 'Удалить файл везде?'),
			message: t(
				'File “{path}” will be deleted on the phone and the desktop. A tombstone will remain in the manifest, but there will be no copy to restore from.',
				'Файл «{path}» будет удалён на телефоне и на ПК. Tombstone останется в манифесте, но содержимое восстановить будет неоткуда.',
				{ path: view.path },
			),
			confirmText: t('Delete everywhere', 'Удалить везде'),
			destructive: true,
		});
		if (!confirmed || !this.beginAction(view)) {
			return;
		}
		try {
			await this.plugin.deleteEverywhere(view.path);
			this.finishAction(view, 'done', t('Deleted everywhere', 'Удалено везде'));
		} catch (error) {
			this.failAction(view, error);
		}
	}

	private skip(view: AnyView): void {
		if (view.busy || view.status !== 'pending') {
			return;
		}
		this.finishAction(view, 'skipped', t('Skipped without changes', 'Пропущено без изменений'));
	}

	private async applyTwoWay(): Promise<void> {
		if (this.bulkRunning || this.closed) {
			return;
		}
		const plan: Deal[] = [];
		const deletionCandidates: ConflictView[] = [];

		for (const view of this.conflictViews) {
			if (view.status !== 'pending') {
				continue;
			}
			const conflict = view.conflict;
			switch (conflict.reason) {
				case 'only_on_client':
					plan.push({ view, action: 'upload' });
					break;
				case 'only_on_server':
					plan.push({ view, action: 'download' });
					break;
				case 'modified_after_server_delete':
					plan.push({ view, action: 'upload' });
					break;
				case 'modified_after_client_delete':
					plan.push({ view, action: 'download' });
					break;
				case 'deleted_on_server':
					if (
						conflict.client?.status === 'active'
						&& conflict.client.mtime > (conflict.server?.deletedAt ?? 0)
					) {
						plan.push({ view, action: 'upload' });
					} else {
						deletionCandidates.push(view);
					}
					break;
				case 'deleted_on_client':
					if (
						conflict.server?.status === 'active'
						&& conflict.server.mtime > (conflict.client?.deletedAt ?? 0)
					) {
						plan.push({ view, action: 'download' });
					} else {
						deletionCandidates.push(view);
					}
					break;
			}
		}

		for (const view of deletionCandidates) {
			if (this.closed) {
				return;
			}
			let decision: DeleteDecision = 'skip';
			try {
				decision = await confirmDeletionWithPreview(this.app, this.plugin, view.conflict);
			} catch (error) {
				new Notice(
					t('Could not open the deletion preview: {error}', 'Не удалось открыть превью удаления: {error}', {
						error: errorMessage(error),
					}),
					8000,
				);
				continue;
			}
			if (decision === 'delete') {
				plan.push({ view, action: 'delete' });
			} else if (decision === 'restore') {
				plan.push({
					view,
					action: view.conflict.reason === 'deleted_on_client' ? 'download' : 'upload',
				});
			}
		}

		for (const view of this.contentViews) {
			if (view.status !== 'pending') {
				continue;
			}
			const clientTime = view.diff.client.mtime;
			const serverTime = view.diff.server.mtime;
			if (clientTime > serverTime) {
				plan.push({ view, action: 'upload' });
			} else if (serverTime > clientTime) {
				plan.push({ view, action: 'download' });
			}
		}

		if (plan.length === 0) {
			new Notice(
				t(
					'Nothing to synchronize: the remaining files were skipped or have equal timestamps.',
					'Нечего синхронизировать: оставшиеся файлы пропущены или имеют одинаковое время изменения.',
				),
			);
			return;
		}
		await this.executePlan(plan);
	}

	private getParallelism(): number {
		const value = this.plugin.settings.parallelTransfers;
		if (!Number.isFinite(value)) {
			return 4;
		}
		return Math.max(1, Math.min(6, Math.round(value)));
	}

	private decideConflict(conflict: FileConflict, mode: BulkMode): BulkAction | null {
		const clientActive = conflict.client?.status === 'active';
		const serverActive = conflict.server?.status === 'active';
		if (mode === 'pull') {
			if (serverActive) {
				return 'download';
			}
			if (clientActive) {
				return 'delete';
			}
			return null;
		}
		if (mode === 'push') {
			if (clientActive) {
				return 'upload';
			}
			if (serverActive) {
				return 'delete';
			}
			return null;
		}
		const preset = defaultActionFor(conflict.reason);
		if (preset === 'upload') {
			return clientActive ? 'upload' : null;
		}
		return serverActive ? 'download' : null;
	}

	private async applyBulkConflicts(mode: BulkMode): Promise<void> {
		if (this.bulkRunning) {
			return;
		}
		const pending = this.conflictViews.filter((view) => view.status === 'pending');
		if (pending.length === 0) {
			return;
		}
		const plan: Deal[] = [];
		for (const view of pending) {
			const action = this.decideConflict(view.conflict, mode);
			if (action) {
				plan.push({ view, action });
			}
		}
		if (plan.length === 0) {
			return;
		}
		const deletes = plan.filter((deal) => deal.action === 'delete').length;
		if (deletes > 0) {
			const confirmed = await confirmAction(this.app, {
				title: t('Delete files everywhere?', 'Удалить файлы везде?'),
				message: t(
					'Files to delete: {count}. The action affects both the phone and the desktop.',
					'Будет удалено файлов: {count}. Действие затронет и телефон, и ПК.',
					{ count: deletes },
				),
				confirmText: t('Delete', 'Удалить'),
				destructive: true,
			});
			if (!confirmed) {
				return;
			}
		}
		await this.executePlan(plan);
	}

	private async applyBulkContent(mode: 'pull' | 'push'): Promise<void> {
		if (this.bulkRunning) {
			return;
		}
		const pending = this.contentViews.filter((view) => view.status === 'pending');
		if (pending.length === 0) {
			return;
		}
		const plan: Deal[] = pending.map((view) => ({
			view,
			action: mode === 'pull' ? 'download' : 'upload',
		}));
		await this.executePlan(plan);
	}

	private async executePlan(plan: Deal[]): Promise<void> {
		if (plan.length === 0) {
			return;
		}
		this.bulkRunning = true;
		this.setBulkDisabled(true);
		this.setActionButtonsDisabled(true);
		if (this.closeButton) {
			this.closeButton.disabled = true;
		}
		let processed = 0;
		let completed = 0;
		let failed = 0;
		let cursor = 0;
		const parallelism = Math.min(this.getParallelism(), plan.length);
		const worker = async (): Promise<void> => {
			while (!this.closed) {
				const index = cursor;
				cursor += 1;
				if (index >= plan.length) {
					return;
				}
				const deal = plan[index];
				if (!this.beginAction(deal.view)) {
					processed += 1;
					continue;
				}
				try {
					if (deal.action === 'upload') {
						await this.plugin.uploadPath(deal.view.path);
						this.finishAction(deal.view, 'done', t('Sent to desktop', 'Отправлено на ПК'));
					} else if (deal.action === 'download') {
						await this.plugin.downloadPath(deal.view.path);
						this.finishAction(deal.view, 'done', t('Received from desktop', 'Получено с ПК'));
					} else {
						await this.plugin.deleteEverywhere(deal.view.path);
						this.finishAction(deal.view, 'done', t('Deleted everywhere', 'Удалено везде'));
					}
					completed += 1;
				} catch (error) {
					failed += 1;
					this.failAction(deal.view, error);
				}
				processed += 1;
				this.showProgress(processed, plan.length);
			}
		};
		try {
			this.showProgress(0, plan.length);
			await Promise.all(Array.from({ length: parallelism }, () => worker()));
		} finally {
			this.bulkRunning = false;
			this.setBulkDisabled(false);
			this.setActionButtonsDisabled(false);
			if (this.closeButton) {
				this.closeButton.disabled = false;
			}
			this.hideProgress();
		}
		if (!this.closed) {
			if (failed > 0) {
				new Notice(
					t('Done: {done}, errors: {failed}', 'Готово: {done}, ошибок: {failed}', {
						done: completed,
						failed,
					}),
					8000,
				);
			} else if (completed > 0) {
				new Notice(t('Done: {done}', 'Готово: {done}', { done: completed }), 4000);
			}
		}
	}

	private renderFooter(): void {
		const footer = this.contentEl.createDiv({ cls: 'lan-sync-footer' });
		const status = footer.createDiv({ cls: 'lan-sync-footer-status' });
		this.footerCountEl = status.createSpan({ cls: 'lan-sync-remaining' });
		this.progressEl = status.createSpan({ cls: 'lan-sync-progress' });
		const close = footer.createEl('button', {
			cls: 'mod-cta',
			text: t('Close', 'Закрыть'),
		});
		this.closeButton = close;
		close.addEventListener('click', () => {
			if (this.bulkRunning) {
				return;
			}
			this.close();
		});
	}

	private updateCounter(): void {
		const remaining = [...this.conflictViews, ...this.contentViews].filter(
			(view) => view.status === 'pending',
		).length;
		if (!this.footerCountEl) {
			return;
		}
		this.footerCountEl.setText(
			remaining === 0
				? t('All conflicts resolved', 'Все конфликты разрешены')
				: t('Remaining conflicts: {count}', 'Осталось конфликтов: {count}', {
						count: remaining,
					}),
		);
		this.footerCountEl.classList.toggle('is-complete', remaining === 0);
		if (remaining === 0 && !this.completionAnnounced) {
			this.completionAnnounced = true;
			new Notice(
				t(
					'All conflicts resolved. You can close this window.',
					'Все конфликты разрешены. Можно закрывать окно.',
				),
			);
		}
	}

	private setBulkDisabled(disabled: boolean): void {
		for (const button of this.bulkButtons) {
			button.disabled = disabled;
		}
	}

	private setActionButtonsDisabled(disabled: boolean): void {
		for (const view of [...this.conflictViews, ...this.contentViews]) {
			if (view.status !== 'pending') {
				continue;
			}
			view.actionsEl.querySelectorAll('button').forEach((button) => {
				button.disabled = disabled;
			});
		}
	}

	private showProgress(done: number, total: number): void {
		this.progressEl?.setText(
			t('Running: {done}/{total}', 'Выполняется: {done}/{total}', { done, total }),
		);
	}

	private hideProgress(): void {
		this.progressEl?.setText('');
	}
}
