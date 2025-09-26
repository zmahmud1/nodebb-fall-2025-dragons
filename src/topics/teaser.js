
'use strict';

const _ = require('lodash');

const db = require('../database');
const meta = require('../meta');
const user = require('../user');
const posts = require('../posts');
const plugins = require('../plugins');
const utils = require('../utils');

module.exports = function (Topics) {
	Topics.getTeasers = async function (topics, options) {
		if (!Array.isArray(topics) || !topics.length) {
			return [];
		}
		let uid = options;
		let { teaserPost } = meta.config;
		if (typeof options === 'object') {
			uid = options.uid;
			teaserPost = options.teaserPost || meta.config.teaserPost;
		}

		const counts = [];
		const teaserPids = [];
		const tidToPost = {};

		topics.forEach((topic) => {
			counts.push(topic && topic.postcount);
			if (topic) {
				if (topic.teaserPid === 'null') {
					delete topic.teaserPid;
				}
				if (teaserPost === 'first') {
					teaserPids.push(topic.mainPid);
				} else if (teaserPost === 'last-post') {
					teaserPids.push(topic.teaserPid || topic.mainPid);
				} else {
					// last-reply and everything else:
					// prefer teaserPid, fallback to mainPid
					teaserPids.push(topic.teaserPid || topic.mainPid);
				}
			}
		});

		// If any teaserPids are falsy (both teaserPid and mainPid missing),
		// try to fetch the latest undeleted reply for those topics
		const missing = [];
		teaserPids.forEach((pid, i) => {
			if (!pid) {
				const tid = topics[i] && topics[i].tid;
				if (tid) {
					missing.push({ idx: i, tid });
				}
			}
		});
		if (missing.length) {
			const missingPromises = missing.map(m =>
				Topics.getLatestUndeletedReply(m.tid)
					.then(pid => ({ idx: m.idx, pid: pid || null })));
			const resolved = await Promise.all(missingPromises);
			resolved.forEach((r) => {
				teaserPids[r.idx] = r.pid;
			});
		}

		// Filter out falsy/invalid teaser PIDs to avoid requesting non-existent post keys
		// Coerce to integers and only allow positive numeric PIDs, deduplicate.
		const validTeaserPids = _.uniq(teaserPids
			.map(pid => parseInt(pid, 10))
			.filter(pid => utils.isNumber(pid) && pid > 0));
		// Extra debug: log the raw teaser PIDs and the valid set when things go wrong.
		try {
			const topicTids = topics.map(t => (t && t.tid));
			console.log(
				'[Topics.getTeasers] teaserPids=%j validTeaserPids=%j topicTids=%j',
				teaserPids,
				validTeaserPids,
				topicTids
			);
		} catch (e) {
			// ignore logging errors
		}

		// Include the `answered` field so topic teasers can show an ANSWERED badge in lists
		const [allPostData, callerSettings] = await Promise.all([
			posts.getPostsFields(validTeaserPids, ['pid', 'uid', 'timestamp', 'tid', 'content', 'sourceContent', 'answered']),
			user.getSettings(uid),
		]);
		let postData = allPostData.filter(post => post && post.pid);

		// Diagnostic: if we requested zero valid teaser pids but the requested list was non-empty,
		// log topic fields to understand why teaser/main PIDs are missing.
		try {
			if (validTeaserPids.length === 0 && teaserPids.length > 0) {
				const tids = topics.map(t => (t && t.tid)).filter(Boolean);
				if (tids.length) {
					const topicFields = await Topics.getTopicsFields(tids, ['tid', 'mainPid', 'teaserPid', 'postcount']);
					console.log('[Topics.getTeasers:diagnostic] topics=%j topicFields=%j', tids, topicFields);
				}
			}
		} catch (e) {
			console.error('[Topics.getTeasers:diagnostic] failed to fetch topic fields', e);
		}
		// Debug: log answered presence for teasers
		try {
			const answeredCount = postData.reduce((acc, p) => acc + (p.answered ? 1 : 0), 0);
			console.log('[Topics.getTeasers] requested=%d validRequested=%d teasers fetched=%d answered=%d', teaserPids.length, validTeaserPids.length, postData.length, answeredCount);
		} catch (e) {
			// ignore
		}
		postData = await handleBlocks(uid, postData);
		postData = postData.filter(Boolean);
		const uids = _.uniq(postData.map(post => post.uid));
		const sortNewToOld = callerSettings.topicPostSort === 'newest_to_oldest';
		const usersData = await user.getUsersFields(uids, ['uid', 'username', 'userslug', 'picture']);

		const users = {};
		usersData.forEach((user) => {
			users[user.uid] = user;
		});
		postData.forEach((post) => {
			// If the post author isn't represented in the retrieved users' data,
			// then it means they were deleted, assume guest.
			if (!users.hasOwnProperty(post.uid)) {
				post.uid = 0;
			}

			post.user = users[post.uid];
			post.timestampISO = utils.toISOString(post.timestamp);
			tidToPost[post.tid] = post;
		});
		await Promise.all(postData.map(p => posts.parsePost(p, 'plaintext')));

		const teasers = topics.map((topic, index) => {
			if (!topic) {
				return null;
			}
			if (tidToPost[topic.tid]) {
				tidToPost[topic.tid].index = calcTeaserIndex(teaserPost, counts[index], sortNewToOld);
			}
			return tidToPost[topic.tid];
		});

		const result = await plugins.hooks.fire('filter:teasers.get', { teasers: teasers, uid: uid });
		return result.teasers;
	};

	function calcTeaserIndex(teaserPost, postCountInTopic, sortNewToOld) {
		if (teaserPost === 'first') {
			return 1;
		}

		if (sortNewToOld) {
			return Math.min(2, postCountInTopic);
		}
		return postCountInTopic;
	}

	async function handleBlocks(uid, teasers) {
		const blockedUids = await user.blocks.list(uid);
		if (!blockedUids.length) {
			return teasers;
		}

		return await Promise.all(teasers.map(async (postData) => {
			if (blockedUids.includes(parseInt(postData.uid, 10))) {
				return await getPreviousNonBlockedPost(postData, blockedUids);
			}
			return postData;
		}));
	}

	async function getPreviousNonBlockedPost(postData, blockedUids) {
		let isBlocked = false;
		let prevPost = postData;
		const postsPerIteration = 5;
		let start = 0;
		let stop = start + postsPerIteration - 1;
		let checkedAllReplies = false;

		function checkBlocked(post) {
			const isPostBlocked = blockedUids.includes(parseInt(post.uid, 10));
			prevPost = !isPostBlocked ? post : prevPost;
			return isPostBlocked;
		}

		do {
			/* eslint-disable no-await-in-loop */
			let pids = await db.getSortedSetRevRange(`tid:${postData.tid}:posts`, start, stop);
			if (!pids.length) {
				checkedAllReplies = true;
				const mainPid = await Topics.getTopicField(postData.tid, 'mainPid');
				pids = [mainPid];
			}
			const prevPosts = await posts.getPostsFields(pids, ['pid', 'uid', 'timestamp', 'tid', 'content']);
			isBlocked = prevPosts.every(checkBlocked);
			start += postsPerIteration;
			stop = start + postsPerIteration - 1;
		} while (isBlocked && prevPost && prevPost.pid && !checkedAllReplies);

		return prevPost;
	}

	Topics.getTeasersByTids = async function (tids, uid) {
		if (!Array.isArray(tids) || !tids.length) {
			return [];
		}
		const topics = await Topics.getTopicsFields(tids, ['tid', 'postcount', 'teaserPid', 'mainPid']);
		return await Topics.getTeasers(topics, uid);
	};

	Topics.getTeaser = async function (tid, uid) {
		const teasers = await Topics.getTeasersByTids([tid], uid);
		return Array.isArray(teasers) && teasers.length ? teasers[0] : null;
	};

	Topics.updateTeaser = async function (tid) {
		let pid = await Topics.getLatestUndeletedReply(tid);
		pid = pid || null;
		if (pid) {
			await Topics.setTopicField(tid, 'teaserPid', pid);
		} else {
			await Topics.deleteTopicField(tid, 'teaserPid');
		}
	};
};
