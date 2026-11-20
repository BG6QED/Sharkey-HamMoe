<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModal ref="modal" :zPriority="'middle'" @click="modal?.close()" @closed="$emit('closed')">
	<div :class="$style.root">
		<div :class="$style.title"><MkSparkle>{{ i18n.ts.misskeyUpdated }}</MkSparkle></div>
		<div :class="$style.version">✨{{ version }}🚀</div>
		<MkButton full @click="whatIsNew">{{ i18n.ts.whatIsNew }}</MkButton>
		<MkButton :class="$style.gotIt" primary full @click="modal?.close()">{{ i18n.ts.gotIt }}</MkButton>
	</div>
</MkModal>
</template>

<script lang="ts" setup>
import { onMounted, useTemplateRef } from 'vue';
import { version } from '@@/js/config.js';
import MkModal from '@/components/MkModal.vue';
import MkButton from '@/components/MkButton.vue';
import MkSparkle from '@/components/MkSparkle.vue';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { confetti } from '@/utility/confetti.js';

const modal = useTemplateRef('modal');

/**
 * 更新情報のリンク先を組み立てる。
 * リポジトリURLはサーバー側の設定（meta.repositoryUrl）に従う。
 * 上流の URL を固定で使うと、独自バージョンを運用しているインスタンスでは
 * 存在しないリリースページ（404）に飛んでしまうため。
 */
function getReleaseUrl(): string {
	const repositoryUrl = instance.repositoryUrl?.replace(/\.git$/, '').replace(/\/+$/, '');
	if (repositoryUrl) {
		return `${repositoryUrl}/releases/tag/${encodeURIComponent(version)}`;
	}
	// リポジトリURLが未設定の場合はリリース一覧にフォールバック
	return 'https://activitypub.software/TransFem-org/Sharkey/-/releases';
}

const whatIsNew = () => {
	modal.value?.close();
	window.open(getReleaseUrl(), '_blank');
};

onMounted(() => {
	confetti({
		duration: 1000 * 3,
	});
});
</script>

<style lang="scss" module>
.root {
	margin: auto;
	position: relative;
	padding: 32px;
	min-width: 320px;
	max-width: 480px;
	box-sizing: border-box;
	text-align: center;
	background: var(--MI_THEME-panel);
	border-radius: var(--MI-radius);
}

.title {
	font-weight: bold;
}

.version {
	margin: 1em 0;
}

.gotIt {
	margin: 8px 0 0 0;
}
</style>
