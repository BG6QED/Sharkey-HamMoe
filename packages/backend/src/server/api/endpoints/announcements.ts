/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueryService } from '@/core/QueryService.js';
import { RoleService } from '@/core/RoleService.js';
import { AnnouncementEntityService } from '@/core/entities/AnnouncementEntityService.js';
import { TimeService } from '@/global/TimeService.js';
import { DI } from '@/di-symbols.js';
import type { AnnouncementsRepository } from '@/models/_.js';

export const meta = {
	tags: ['meta'],

	requireCredential: false,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Announcement',
		},
	},

	// 2 calls per second
	limit: {
		duration: 1000,
		max: 2,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		isActive: { type: 'boolean', default: true },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.announcementsRepository)
		private announcementsRepository: AnnouncementsRepository,

		private queryService: QueryService,
		private roleService: RoleService,
		private announcementEntityService: AnnouncementEntityService,
		private timeService: TimeService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const now = this.timeService.date;
			const roles = me ? await this.roleService.getUserRoles(me) : [];
			const query = this.queryService.makePaginationQuery(this.announcementsRepository.createQueryBuilder('announcement'), ps.sinceId, ps.untilId)
				.andWhere(new Brackets(qb => {
					if (me) qb.orWhere('announcement.userId = :meId', { meId: me.id });
					qb.orWhere('announcement.userId IS NULL');
				}))
				.andWhere(new Brackets(qb => {
					if (me) qb.orWhere('announcement.forRoles && :roles', { roles: roles.map((r) => r.id) });
					qb.orWhere('announcement.forRoles = \'{}\'');
				}));

			if (ps.isActive) {
				query.andWhere('announcement.isActive = true');
				query.andWhere(new Brackets(qb => {
					qb.where('announcement.autoArchiveAt IS NULL');
					qb.orWhere('announcement.autoArchiveAt > :now', { now });
				}));
			} else {
				query.andWhere(new Brackets(qb => {
					qb.where('announcement.isActive = false');
					qb.orWhere('announcement.autoArchiveAt <= :now', { now });
				}));
			}

			const announcements = await query.limit(ps.limit).getMany();

			return await this.announcementEntityService.packMany(announcements, me);
		});
	}
}
