/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AccessTokensRepository } from '@/models/_.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import { DI } from '@/di-symbols.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ApiError } from '../../error.js';

export const meta = {
	requireCredential: true,

	secure: true,

	errors: {
		credentialRequired: {
			message: 'Credential required.',
			code: 'CREDENTIAL_REQUIRED',
			id: '6f1f0d3a-3d5b-4b1f-9c3e-2a6d1e5b8c47',
			httpStatusCode: 401,
		},
		permissionDenied: {
			message: 'Permission denied.',
			code: 'PERMISSION_DENIED',
			id: 'fc20d118-5705-4462-b6c5-2b5b43092cf3',
			httpStatusCode: 403,
		},
	},

	// 10 calls per 5 seconds
	limit: {
		duration: 1000 * 5,
		max: 10,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		tokenId: { type: 'string', format: 'misskey:id' },
		token: { type: 'string', nullable: true },
	},
	anyOf: [
		{ required: ['tokenId'] },
		{ required: ['token'] },
	],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		private readonly notificationService: NotificationService,
	) {
		super(meta, paramDef, async (ps, me, token) => {
			if (me == null) {
				throw new ApiError(meta.errors.credentialRequired);
			}

			let target: MiAccessToken | null = null;
			if (ps.tokenId) {
				target = await this.accessTokensRepository.findOneBy({ id: ps.tokenId, userId: me.id });
			} else if (ps.token) {
				target = await this.accessTokensRepository.findOneBy({ token: ps.token, userId: me.id });
			}

			if (target == null) return;

			// A third-party app may only revoke the access token it is currently using.
			if (token != null && token.id !== target.id) {
				throw new ApiError(meta.errors.permissionDenied);
			}

			for (const granteeId of target.granteeIds) {
				this.notificationService.createNotification(granteeId, 'sharedAccessRevoked', {}, me.id);
			}

			await this.accessTokensRepository.delete({ id: target.id });
		});
	}
}
