/*
 * SPDX-FileCopyrightText: sharkey-hammoe
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * ZIP 中央ディレクトリの事前検査。
 *
 * `slacc` の ZipReader は展開先パスの検証を行わないため、
 * 展開前に「危険なエントリを含んでいないか」をここで確認する。
 *
 * 参考: GHSA-jx9q-24fh-4fxw (任意ファイル書き込み),
 *       GHSA-h3mq-w9gq-6mwm (任意ファイル読み取り)
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export class UnsafeZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsafeZipError';
	}
}

export type ZipGuardOptions = {
	/** 展開後の合計サイズ上限 (bytes) */
	maxTotalBytes: number;
	/** エントリ数上限 */
	maxEntries?: number;
};

type CentralEntry = {
	name: string;
	uncompressedSize: number;
	flags: number;
	externalAttrs: number;
};

function readUInt64(buf: Buffer, offset: number): number {
	const value = buf.readBigUInt64LE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new UnsafeZipError('zip64 field is out of range');
	}
	return Number(value);
}

/**
 * EOCD (および必要なら ZIP64 EOCD) を探して中央ディレクトリの範囲を返す
 */
function locateCentralDirectory(buf: Buffer): { offset: number; size: number; entries: number } {
	// EOCD は末尾から最大 65557 byte 以内にある (コメント領域を含む)
	const searchStart = Math.max(0, buf.length - (0xffff + 22));
	let eocd = -1;
	for (let i = buf.length - 22; i >= searchStart; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd === -1) {
		throw new UnsafeZipError('not a zip file');
	}

	let entries = buf.readUInt16LE(eocd + 10);
	let cdSize = buf.readUInt32LE(eocd + 12);
	let cdOffset = buf.readUInt32LE(eocd + 16);

	const needsZip64 = entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
	if (needsZip64) {
		// ZIP64 EOCD locator は EOCD の直前 20 byte
		const locator = eocd - 20;
		if (locator < 0 || buf.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG) {
			throw new UnsafeZipError('zip64 locator is missing');
		}
		const eocd64Offset = readUInt64(buf, locator + 8);
		if (eocd64Offset + 56 > buf.length || buf.readUInt32LE(eocd64Offset) !== EOCD64_SIG) {
			throw new UnsafeZipError('zip64 end of central directory is invalid');
		}
		entries = readUInt64(buf, eocd64Offset + 32);
		cdSize = readUInt64(buf, eocd64Offset + 40);
		cdOffset = readUInt64(buf, eocd64Offset + 48);
	}

	if (cdOffset + cdSize > buf.length) {
		throw new UnsafeZipError('central directory is out of range');
	}

	return { offset: cdOffset, size: cdSize, entries };
}

function isUnsafeEntryName(name: string): string | null {
	if (name.length === 0) return 'empty name';
	if (name.includes('\0')) return 'NUL byte in name';
	// Windows の区切り文字も拒否する (展開先が Windows の可能性があるため)
	if (name.includes('\\')) return 'backslash in name';
	if (name.startsWith('/')) return 'absolute path';
	if (/^[a-zA-Z]:/.test(name)) return 'drive letter in name';

	const segments = name.split('/');
	if (segments.some(s => s === '..')) return 'parent directory reference';

	return null;
}

function parseCentralDirectory(buf: Buffer, offset: number, size: number, entries: number): CentralEntry[] {
	const result: CentralEntry[] = [];
	let p = offset;
	const end = offset + size;

	for (let i = 0; i < entries; i++) {
		if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL_SIG) {
			throw new UnsafeZipError('central directory is corrupted');
		}

		const flags = buf.readUInt16LE(p + 8);
		const compressedSize = buf.readUInt32LE(p + 20);
		const uncompressedSize = buf.readUInt32LE(p + 24);
		const nameLength = buf.readUInt16LE(p + 28);
		const extraLength = buf.readUInt16LE(p + 30);
		const commentLength = buf.readUInt16LE(p + 32);
		const externalAttrs = buf.readUInt32LE(p + 38);

		if (p + 46 + nameLength > end) {
			throw new UnsafeZipError('central directory entry is truncated');
		}

		const name = buf.toString('utf8', p + 46, p + 46 + nameLength);

		result.push({
			name,
			uncompressedSize: uncompressedSize === 0xffffffff ? 0 : uncompressedSize,
			flags,
			externalAttrs,
		});

		// ZIP64 拡張フィールドがある場合はサイズが 0xffffffff になっているので、
		// 安全側に倒して「不明なサイズ」として扱う (合計サイズ検査で弾く)
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
			result[result.length - 1].uncompressedSize = Number.POSITIVE_INFINITY;
		}

		p += 46 + nameLength + extraLength + commentLength;
	}

	return result;
}

/**
 * ZIP のエントリを検査し、危険なものが含まれていれば例外を投げる。
 */
export function assertSafeZipEntries(buf: Buffer, options: ZipGuardOptions): void {
	const maxEntries = options.maxEntries ?? 10000;
	const { offset, size, entries } = locateCentralDirectory(buf);

	if (entries > maxEntries) {
		throw new UnsafeZipError(`too many entries: ${entries}`);
	}

	const central = parseCentralDirectory(buf, offset, size, entries);

	let total = 0;
	for (const entry of central) {
		const unsafe = isUnsafeEntryName(entry.name);
		if (unsafe != null) {
			throw new UnsafeZipError(`unsafe entry name (${unsafe}): ${JSON.stringify(entry.name)}`);
		}

		// 暗号化エントリは扱わない
		if ((entry.flags & 0x1) !== 0) {
			throw new UnsafeZipError(`encrypted entry is not allowed: ${JSON.stringify(entry.name)}`);
		}

		// Unix mode が symlink のエントリを拒否する
		const unixMode = entry.externalAttrs >>> 16;
		if ((unixMode & S_IFMT) === S_IFLNK) {
			throw new UnsafeZipError(`symlink entry is not allowed: ${JSON.stringify(entry.name)}`);
		}

		total += entry.uncompressedSize;
		if (!Number.isFinite(total) || total > options.maxTotalBytes) {
			throw new UnsafeZipError('uncompressed size exceeds the limit');
		}
	}
}
