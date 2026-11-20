import { miLocalStorage } from '@/local-storage.js';

/**
 * 这些字体的样式规则写在 `styles-font/sharkey-default.scss` 里（随主样式表一起加载），
 * 不需要单独动态导入。
 */
const defaultFontsList = [
	'sharkey-default',
	'roboto',
	'misskey-biz',
	'arial',
	'times',
	'system-ui',
];

const FONT_CLASS_PREFIX = 'default-font-';

export async function loadFontStyle(fontId: string) {
	if (defaultFontsList.includes(fontId)) return;
	if (fontId === 'custom') {
		const font = miLocalStorage.getItem('customFontFaceName') ?? 'Arial';
		window.document.documentElement.style.setProperty('--STPV_custom-fontface', font);
		return;
	}
	try {
		await import(`@/styles-font/${fontId}.scss`);
	} catch (err) {
		console.warn(`Failed to load font style: ${fontId}`, err);
	}
}

/**
 * 把字体设置（含字重/像素等变体，如 `chillroundgothic_N`、`fusion-pixel_12`）
 * 真正应用到 `<html>` 上：切换 `default-font-*` 类 + 按需加载字体样式表。
 *
 * 注意：字体样式表的规则都写成 `html.default-font-xxx`，只导入 CSS 而不加类是不会生效的，
 * 所以刷新后必须在 boot 阶段重新调用本函数，否则字体会回退到默认字体。
 */
export async function applyDefaultFont(fontIdWithVariant: string | null | undefined) {
	const el = window.document.documentElement;

	for (const klass of [...el.classList.values()]) {
		if (klass.startsWith(FONT_CLASS_PREFIX)) {
			el.classList.remove(klass);
		}
	}

	if (fontIdWithVariant == null || fontIdWithVariant === '') return;

	// `default-font-` 后面的部分带变体信息，而字体样式表按基础字体 id 命名
	const fontId = fontIdWithVariant.split('_')[0];
	el.classList.add(`${FONT_CLASS_PREFIX}${fontIdWithVariant}`);

	await loadFontStyle(fontId);
}
