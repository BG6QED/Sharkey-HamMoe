/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Brackets, EntityNotFoundError, IsNull, Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { MiUser } from '@/models/User.js';
import type { AnnouncementReadsRepository, AnnouncementsRepository, MiAnnouncement, MiAnnouncementRead, UsersRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { Packed } from '@/misc/json-schema.js';
import { IdService } from '@/core/IdService.js';
import { AnnouncementEntityService } from '@/core/entities/AnnouncementEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { Config } from '@/config.js';
import { RoleService } from '@/core/RoleService.js';
import { TimeService } from '@/global/TimeService.js';
import { CacheService } from '@/core/CacheService.js';
import { QueueService } from '@/core/QueueService.js';

@Injectable()
export class AnnouncementService implements OnApplicationBootstrap {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.announcementsRepository)
		private announcementsRepository: AnnouncementsRepository,

		@Inject(DI.announcementReadsRepository)
		private announcementReadsRepository: AnnouncementReadsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private globalEventService: GlobalEventService,
		private moderationLogService: ModerationLogService,
		private announcementEntityService: AnnouncementEntityService,
		private roleService: RoleService,
		private readonly timeService: TimeService,
		private readonly cacheService: CacheService,
		private queueService: QueueService,
	) {
	}

	@bindThis
	public async onApplicationBootstrap(): Promise<void> {
		// QueueService の初期化は onModuleInit で完了しているため、ここで予約を復元できる
		// アップデート前に作成されたお知らせや Redis の再構築後にも予約を復元する
		const announcements = await this.announcementsRepository.findBy({
			isActive: true,
			autoArchiveAt: Not(IsNull()),
		});

		await Promise.all(announcements.map(announcement =>
			this.queueService.scheduleAnnouncementArchive(announcement.id, announcement.autoArchiveAt as Date),
		));
	}

	@bindThis
	public async getReads(userId: MiUser['id']): Promise<MiAnnouncementRead[]> {
		return this.announcementReadsRepository.findBy({
			userId: userId,
		});
	}

	@bindThis
	public async getUnreadAnnouncements(user: MiUser): Promise<MiAnnouncement[]> {
		const readsQuery = this.announcementReadsRepository.createQueryBuilder('read')
			.select('read.announcementId')
			.where('read.userId = :userId', { userId: user.id });
		const roles = await this.roleService.getUserRoles(user);

		const now = this.timeService.date;
		const q = this.announcementsRepository.createQueryBuilder('announcement')
			.where('announcement.isActive = true')
			.andWhere(new Brackets(qb => {
				qb.where('announcement.autoArchiveAt IS NULL');
				qb.orWhere('announcement.autoArchiveAt > :now', { now });
			}))
			.andWhere('announcement.silence = false')
			.andWhere(new Brackets(qb => {
				qb.orWhere('announcement.userId = :userId', { userId: user.id });
				qb.orWhere('announcement.userId IS NULL');
			}))
			.andWhere(new Brackets(qb => {
				qb.orWhere('announcement.forExistingUsers = false');
				qb.orWhere('announcement.id > :userId', { userId: user.id });
			}))
			.andWhere(new Brackets(qb => {
				qb.orWhere('announcement.forRoles && :roles', { roles: roles.map((r) => r.id) });
				qb.orWhere('announcement.forRoles = \'{}\'');
			}))
			.andWhere(`announcement.id NOT IN (${ readsQuery.getQuery() })`);

		q.setParameters(readsQuery.getParameters());

		return q.getMany();
	}

	@bindThis
	public async create(values: Partial<MiAnnouncement>, moderator?: MiUser): Promise<{ raw: MiAnnouncement; packed: Packed<'Announcement'> }> {
		if (values.display === 'dialog') {
			await this.assertDialogAnnouncementsCountLimit();
		}

		const announcement = await this.announcementsRepository.insertOne({
			id: this.idService.gen(),
			updatedAt: null,
			title: values.title,
			text: values.text,
			imageUrl: values.imageUrl || null,
			icon: values.icon,
			display: values.display,
			forExistingUsers: values.forExistingUsers,
			forRoles: values.forRoles,
			silence: values.silence,
			needConfirmationToRead: values.needConfirmationToRead,
			confetti: values.confetti,
			userId: values.userId,
			autoArchiveAt: values.autoArchiveAt ?? null,
			isActive: values.isActive ?? (values.autoArchiveAt == null || values.autoArchiveAt > this.timeService.date),
		});

		const packed = await this.announcementEntityService.pack(announcement);

		if (announcement.isActive && announcement.autoArchiveAt != null) {
			await this.queueService.scheduleAnnouncementArchive(announcement.id, announcement.autoArchiveAt);
		}

		// 作成処理中に autoArchiveAt を過ぎる可能性があるため、非アクティブならイベント配信しない
		if (values.userId) {
			if (announcement.isActive) {
				this.globalEventService.publishMainStream(values.userId, 'announcementCreated', {
					announcement: packed,
				});
			}

			if (moderator) {
				const user = await this.cacheService.findUserById(values.userId);
				this.moderationLogService.log(moderator, 'createUserAnnouncement', {
					announcementId: announcement.id,
					announcement: announcement,
					userId: values.userId,
					userUsername: user.username,
					userHost: user.host,
				});
			}
		} else {
			if (announcement.isActive) {
				this.globalEventService.publishBroadcastStream('announcementCreated', {
					announcement: packed,
				});
			}

			if (moderator) {
				this.moderationLogService.log(moderator, 'createGlobalAnnouncement', {
					announcementId: announcement.id,
					announcement: announcement,
				});
			}
		}

		return {
			raw: announcement,
			packed: packed,
		};
	}

	@bindThis
	public async update(announcement: MiAnnouncement, values: Partial<MiAnnouncement>, moderator?: MiUser): Promise<void> {
		// Check if this operation would produce an active dialog announcement
		if ((values.display ?? announcement.display) === 'dialog' && (values.isActive ?? announcement.isActive)) {
			await this.assertDialogAnnouncementsCountLimit();
		}

		await this.announcementsRepository.update(announcement.id, {
			updatedAt: this.timeService.date,
			title: values.title,
			text: values.text,
			/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 空の文字列の場合、nullを渡すようにするため */
			imageUrl: values.imageUrl || null,
			display: values.display,
			icon: values.icon,
			forExistingUsers: values.forExistingUsers,
			forRoles: values.forRoles,
			silence: values.silence,
			needConfirmationToRead: values.needConfirmationToRead,
			confetti: values.confetti,
			isActive: values.isActive,
			autoArchiveAt: values.autoArchiveAt,
		});

		const after = await this.announcementsRepository.findOneByOrFail({ id: announcement.id });

		if (announcement.autoArchiveAt?.getTime() !== after.autoArchiveAt?.getTime() || announcement.isActive !== after.isActive) {
			if (announcement.autoArchiveAt != null) {
				await this.queueService.clearAnnouncementArchive(announcement.id, announcement.autoArchiveAt);
			}

			if (after.isActive && after.autoArchiveAt != null) {
				await this.queueService.scheduleAnnouncementArchive(after.id, after.autoArchiveAt);
			}
		}

		if (moderator) {
			if (announcement.userId) {
				const user = await this.cacheService.findUserById(announcement.userId);
				this.moderationLogService.log(moderator, 'updateUserAnnouncement', {
					announcementId: announcement.id,
					before: announcement,
					after: after,
					userId: announcement.userId,
					userUsername: user.username,
					userHost: user.host,
				});
			} else {
				this.moderationLogService.log(moderator, 'updateGlobalAnnouncement', {
					announcementId: announcement.id,
					before: announcement,
					after: after,
				});
			}
		}
	}

	@bindThis
	public async archiveAnnouncement(announcementId: MiAnnouncement['id'], autoArchiveAt: Date): Promise<boolean> {
		const now = this.timeService.date;

		// 日時も照合し、日時変更前に予約された古いジョブがお知らせをアーカイブしないようにする
		const result = await this.announcementsRepository.createQueryBuilder()
			.update()
			.set({
				isActive: false,
				updatedAt: now,
			})
			.where('id = :announcementId', { announcementId })
			.andWhere('isActive = true')
			.andWhere('autoArchiveAt = :autoArchiveAt', { autoArchiveAt })
			.andWhere('autoArchiveAt <= :now', { now })
			.execute();

		return (result.affected ?? 0) > 0;
	}

	@bindThis
	public async delete(announcement: MiAnnouncement, moderator?: MiUser): Promise<void> {
		await this.announcementsRepository.delete(announcement.id);

		if (announcement.autoArchiveAt != null) {
			await this.queueService.clearAnnouncementArchive(announcement.id, announcement.autoArchiveAt);
		}

		if (moderator) {
			if (announcement.userId) {
				const user = await this.cacheService.findUserById(announcement.userId);
				this.moderationLogService.log(moderator, 'deleteUserAnnouncement', {
					announcementId: announcement.id,
					announcement: announcement,
					userId: announcement.userId,
					userUsername: user.username,
					userHost: user.host,
				});
			} else {
				this.moderationLogService.log(moderator, 'deleteGlobalAnnouncement', {
					announcementId: announcement.id,
					announcement: announcement,
				});
			}
		}
	}

	@bindThis
	public async getAnnouncement(announcementId: MiAnnouncement['id'], me: MiUser | null): Promise<Packed<'Announcement'>> {
		const announcement = await this.announcementsRepository.findOneByOrFail({ id: announcementId });

		if (announcement.userId && (me == null || announcement.userId !== me.id)) {
			throw new EntityNotFoundError(this.announcementsRepository.metadata.target, { id: announcementId });
		}

		if (me) {
			const read = await this.announcementReadsRepository.findOneBy({
				announcementId: announcement.id,
				userId: me.id,
			});
			return await this.announcementEntityService.pack({ ...announcement, isRead: read !== null }, me);
		} else {
			return await this.announcementEntityService.pack(announcement, null);
		}
	}

	@bindThis
	public async read(user: MiUser, announcementId: MiAnnouncement['id']): Promise<void> {
		try {
			await this.announcementReadsRepository.insert({
				id: this.idService.gen(),
				announcementId: announcementId,
				userId: user.id,
			});
		} catch (e) {
			return;
		}

		const announcement = await this.announcementsRepository.findOneBy({ id: announcementId });
		if (announcement != null && announcement.userId === user.id) {
			await this.announcementsRepository.update(announcementId, {
				isActive: false,
			});
		}

		if ((await this.getUnreadAnnouncements(user)).length === 0) {
			await this.globalEventService.publishMainStream(user.id, 'readAllAnnouncements', {});
		}
	}

	private async assertDialogAnnouncementsCountLimit(): Promise<void> {
		// Check how many active dialog queries already exist, to enforce a limit
		const dialogCount = await this.announcementsRepository.createQueryBuilder('announcement')
			.where({
				isActive: true,
				display: 'dialog',
			})
			.getCount();
		if (dialogCount >= this.config.maxDialogAnnouncements) {
			throw new IdentifiableError('c0d15f15-f18e-4a40-bcb1-f310d58204ee', 'Too many dialog announcements.');
		}
	}
}
