/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { parseFeed } from 'htmlparser2';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { ApiError } from '../error.js';
import type { FeedItem } from 'domutils';

const MAX_URL_LENGTH = 8192;
const MAX_RESPONSE_SIZE = 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 32;

export const meta = {
	tags: ['meta'],

	requireCredential: false,
	allowGet: true,
	cacheSec: 60 * 3,

	errors: {
		fetchFailed: {
			id: '88f4356f-719d-4715-b4fc-703a10a812d2',
			code: 'FETCH_FAILED',
			message: 'Failed to fetch RSS feed',
		},
		invalidUrl: {
			message: 'Invalid URL.',
			code: 'INVALID_URL',
			id: '89b7ee05-ccfc-4bdd-9b13-61172fd1e06c',
			httpStatusCode: 400,
		},
		fetchRssUnavailable: {
			message: 'RSS fetching is temporarily unavailable.',
			code: 'FETCH_RSS_UNAVAILABLE',
			id: '91e6ff44-c63f-4725-9ad0-b7a40d7f7655',
			kind: 'server',
			httpStatusCode: 503,
		},
	},

	res: {
		type: 'object',
		properties: {
			type: {
				type: 'string',
				optional: false,
			},
			id: {
				type: 'string',
				optional: true,
			},
			updated: {
				type: 'string',
				optional: true,
			},
			author: {
				type: 'string',
				optional: true,
			},
			link: {
				type: 'string',
				optional: true,
			},
			title: {
				type: 'string',
				optional: true,
			},
			items: {
				type: 'array',
				optional: false,
				items: {
					type: 'object',
					properties: {
						link: {
							type: 'string',
							optional: true,
						},
						guid: {
							type: 'string',
							optional: true,
						},
						title: {
							type: 'string',
							optional: true,
						},
						pubDate: {
							type: 'string',
							optional: true,
						},
						description: {
							type: 'string',
							optional: true,
						},
						media: {
							type: 'array',
							optional: false,
							items: {
								type: 'object',
								properties: {
									medium: {
										type: 'string',
										optional: true,
									},
									url: {
										type: 'string',
										optional: true,
									},
									type: {
										type: 'string',
										optional: true,
									},
									lang: {
										type: 'string',
										optional: true,
									},
								},
							},
						},
					},
				},
			},
			description: {
				type: 'string',
				optional: true,
			},
		},
	},

	// 20 calls per 10 seconds
	limit: {
		duration: 1000 * 10,
		max: 20,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		url: { type: 'string' },
	},
	required: ['url'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	private readonly inFlightRequests = new Map<string, Promise<any>>();
	private activeRequestCount = 0;

	constructor(
		private httpRequestService: HttpRequestService,
	) {
		super(meta, paramDef, async (ps) => {
			const url = this.normalizeUrl(ps.url);
			const inFlight = this.inFlightRequests.get(url);
			if (inFlight) return await inFlight;

			if (this.activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
				throw new ApiError(meta.errors.fetchRssUnavailable);
			}

			this.activeRequestCount++;
			const request = this.fetchRss(url)
				.catch(() => {
					throw new ApiError(meta.errors.fetchFailed);
				})
				.finally(() => {
					this.inFlightRequests.delete(url);
					this.activeRequestCount--;
				});
			this.inFlightRequests.set(url, request);
			return await request;
		});
	}

	private normalizeUrl(input: string): string {
		if (input.length === 0 || input.length > MAX_URL_LENGTH) {
			throw new ApiError(meta.errors.invalidUrl);
		}

		let url: URL;
		try {
			url = new URL(input);
		} catch {
			throw new ApiError(meta.errors.invalidUrl);
		}

		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
			throw new ApiError(meta.errors.invalidUrl);
		}

		url.hash = '';
		return url.href;
	}

	private async fetchRss(url: string): Promise<any> {
		const res = await this.httpRequestService.send(url, {
			method: 'GET',
			headers: {
				Accept: 'application/rss+xml, */*',
			},
			timeout: 5000,
			size: MAX_RESPONSE_SIZE,
		});

		const finalUrl = new URL(res.url);
		if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') {
			throw new Error('Invalid final URL protocol');
		}

		const text = await res.text();
		const feed = parseFeed(text, {
			xmlMode: true,
		});

		if (!feed) {
			throw new ApiError(meta.errors.fetchFailed);
		}

		return {
			type: feed.type,
			id: feed.id,
			title: feed.title,
			link: feed.link,
			description: feed.description,
			updated: feed.updated?.toISOString(),
			author: feed.author,
			items: feed.items
				.filter((item): item is FeedItem & { link: string, title: string } => !!item.link && !!item.title)
				.map(item => ({
					guid: item.id,
					title: item.title,
					link: item.link,
					description: item.description,
					pubDate: item.pubDate?.toISOString(),
					media: item.media.map(media => ({
						medium: media.medium,
						url: media.url,
						type: media.type,
						lang: media.lang,
					})),
				})),
		};
	}
}
