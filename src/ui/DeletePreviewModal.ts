import type { App } from 'obsidian';
import { Modal } from 'obsidian';
import type LanSyncPlugin from '../main';
import type { FileConflict } from '../types';
import { t } from '../i18n';
import {
	decodeUtf8,
	errorMessage,
	formatBytes,
	formatTimestamp,
	getImageMime,
	isImagePath,
	isTextPath,
} from '../utils';

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;

export type DeleteDecision = 'delete' | 'restore' | 'skip';

/**
 * Confirmation for propagating a deletion. Shows the file that still exists on
 * the other side so the user can see exactly what will be deleted.
 */
class DeletePreviewModal extends Modal {
	private readonly plugin: LanSyncPlugin;
	private readonly conflict: FileConflict;
	private readonly onResolve: (decision: DeleteDecision) => void;
	private decision: DeleteDecision = 'skip';
	private readonly objectUrls: string[] = [];

	constructor(
		app: App,
		plugin: LanSyncPlugin,
		conflict: FileConflict,
		onResolve: (decision: DeleteDecision) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.conflict = conflict;
		this.onResolve = onResolve;
	}

	override onOpen(): void {
		this.contentEl.addClass('lan-sync-delete-preview');
		const activeOnPhone = this.conflict.client?.status === 'active';
		const active = activeOnPhone ? this.conflict.client : this.conflict.server;
		this.titleEl.setText(t('Delete this file?', 'Удалить этот файл?'));

		this.contentEl.createEl('p', {
			text: activeOnPhone
				? t(
						'“{path}” was deleted on the desktop but still exists on the phone. Delete it on the phone too?',
						'«{path}» удалён на ПК, но ещё есть на телефоне. Удалить его и на телефоне?',
						{ path: this.conflict.path },
					)
				: t(
						'“{path}” was deleted on the phone but still exists on the desktop. Delete it on the desktop too?',
						'«{path}» удалён на телефоне, но ещё есть на ПК. Удалить его и на ПК?',
						{ path: this.conflict.path },
					),
		});
		if (active) {
			this.contentEl.createEl('p', {
				cls: 'lan-sync-hint',
				text: `${formatBytes(active.size)} · ${formatTimestamp(active.mtime)}`,
			});
		}

		const preview = this.contentEl.createDiv({ cls: 'lan-sync-preview' });
		const loading = preview.createDiv({
			cls: 'lan-sync-loading',
			text: t('Loading the file…', 'Загрузка файла…'),
		});

		void (async () => {
			try {
				const data = activeOnPhone
					? await this.plugin.readLocalBinary(this.conflict.path)
					: await this.plugin.readServerBinary(this.conflict.path);
				loading.remove();
				if (!this.contentEl.isConnected) {
					return;
				}
				if (!data) {
					preview.createDiv({
						cls: 'lan-sync-empty',
						text: t('The file is no longer available.', 'Файл больше недоступен.'),
					});
					return;
				}
				if (isTextPath(this.conflict.path) && data.byteLength <= MAX_TEXT_PREVIEW_BYTES) {
					const text = preview.createEl('pre', { cls: 'lan-sync-text' });
					text.setText(decodeUtf8(data));
					return;
				}
				if (isImagePath(this.conflict.path) && data.byteLength <= MAX_IMAGE_PREVIEW_BYTES) {
					const url = URL.createObjectURL(
						new Blob([data], { type: getImageMime(this.conflict.path) }),
					);
					this.objectUrls.push(url);
					const image = preview.createEl('img', { cls: 'lan-sync-image' });
					image.src = url;
					image.alt = this.conflict.path;
					return;
				}
				preview.createDiv({
					cls: 'lan-sync-empty',
					text: t(
						'Binary file: preview is not available, check the size and date above.',
						'Бинарный файл: предпросмотр недоступен, проверьте размер и дату выше.',
					),
				});
			} catch (error) {
				loading.setText(
					t('Could not load the preview: {error}', 'Не удалось загрузить превью: {error}', {
						error: errorMessage(error),
					}),
				);
			}
		})();

		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container lan-sync-delete-buttons' });
		const skip = buttons.createEl('button', {
			text: t('Skip', 'Пропустить'),
		});
		skip.addEventListener('click', () => {
			this.decision = 'skip';
			this.close();
		});
		const restore = buttons.createEl('button', {
			cls: 'mod-cta',
			text: activeOnPhone
				? t('Restore on desktop', 'Восстановить на ПК')
				: t('Restore on phone', 'Восстановить на телефоне'),
		});
		restore.addEventListener('click', () => {
			this.decision = 'restore';
			this.close();
		});
		const remove = buttons.createEl('button', {
			cls: 'mod-warning',
			text: activeOnPhone
				? t('Delete on phone', 'Удалить на телефоне')
				: t('Delete on desktop', 'Удалить на ПК'),
		});
		remove.addEventListener('click', () => {
			this.decision = 'delete';
			this.close();
		});
	}

	override onClose(): void {
		for (const url of this.objectUrls) {
			URL.revokeObjectURL(url);
		}
		this.objectUrls.length = 0;
		this.contentEl.empty();
		this.onResolve(this.decision);
	}
}

export function confirmDeletionWithPreview(
	app: App,
	plugin: LanSyncPlugin,
	conflict: FileConflict,
): Promise<DeleteDecision> {
	return new Promise<DeleteDecision>((resolve) => {
		new DeletePreviewModal(app, plugin, conflict, resolve).open();
	});
}
