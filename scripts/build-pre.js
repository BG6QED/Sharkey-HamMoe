/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';

const __dirname = import.meta.dirname;
const packageJsonPath = __dirname + '/../package.json';

function getGitVersion(versionFromPackageJson) {
	// Sharkey-HamMoe: use the clean version string without a git hash suffix,
	// so the banner reads "Sharkey-HamMoe v2026.11.0".
	return versionFromPackageJson;
}

function build() {
	try {
		const json = fs.readFileSync(packageJsonPath, 'utf-8');
		const meta = JSON.parse(json);

		let gitVersion;
		try {
			gitVersion = getGitVersion(meta.version);
		} catch (e) {
			console.warn('couldn\'t get git commit details, ignoring', e);
		}

		fs.mkdirSync(__dirname + '/../built', { recursive: true });
		fs.writeFileSync(__dirname + '/../built/meta.json', JSON.stringify({ version: meta.version, gitVersion }), 'utf-8');
	} catch (e) {
		console.error(e);
	}
}

if (!process.argv.includes('--fast')) {
	build();
}

if (process.argv.includes('--watch')) {
	fs.watch(packageJsonPath, (event, filename) => {
		console.log(`update ${filename} ...`);
		build();
	});
}
