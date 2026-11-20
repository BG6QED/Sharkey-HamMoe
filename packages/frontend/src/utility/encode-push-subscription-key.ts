/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * PushSubscription の鍵 (auth / p256dh) をサーバーへ送る base64 形式に変換する。
 * sw/register と sw/unregister で同じ形式を使う必要がある。
 */
export function encodePushSubscriptionKey(buffer: ArrayBuffer | null): string {
	return btoa(String.fromCharCode(...(buffer != null ? new Uint8Array(buffer) : [])));
}
