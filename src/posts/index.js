'use strict';

const db = require('../database');
const _ = require('lodash');

const Posts = { answered: {} };     
module.exports = Posts;
require('./answered')(Posts);

const utils = require('../utils');
const user = require('../user');
const privileges = require('../privileges');
const plugins = require('../plugins');

Posts.setAnswered = async function setAnswered(pid, answered /*, actorUid */) {
	// These helpers are attached by ./data later — but we just *call* them at runtime,
	// after all requires finish. It’s safe.
	const fields = await Posts.getPostFields(pid, ['tid', 'timestamp', 'deleted', 'answered']);
	if (!fields || !fields.tid) {
		throw new Error('[[error:no-post]]');
	}

	const tid = Number(fields.tid);
	const nextVal = answered ? 1 : 0;

	// No-op if already in desired state
	if (Number(fields.answered) === nextVal) {
		return { pid: Number(pid), tid, answered: nextVal };
	}

	// Persist the flag
	await Posts.setPostField(pid, 'answered', nextVal);

	// Maintain indices
	const score = Date.now();
	const globalKey = 'posts:answered';
	const topicKey = `tid:${tid}:answered`;

	if (nextVal === 1 && Number(fields.deleted) !== 1) {
		// Add to both sorted sets (use single-key helpers for compatibility with the test db mock)
		await db.sortedSetAdd(globalKey, score, pid);
		await db.sortedSetAdd(topicKey, score, pid);
	} else {
		// Remove from both indices
		await db.sortedSetRemove(globalKey, pid);
		await db.sortedSetRemove(topicKey, pid);
	}

	return { pid: Number(pid), tid, answered: nextVal };
};

require('./data')(Posts);
require('./create')(Posts);
require('./delete')(Posts);
require('./edit')(Posts);
require('./parse')(Posts);
require('./user')(Posts);
require('./topics')(Posts);
require('./category')(Posts);
require('./summary')(Posts);
require('./recent')(Posts);
require('./tools')(Posts);
require('./votes')(Posts);
require('./bookmarks')(Posts);
require('./queue')(Posts);
require('./diffs')(Posts);
require('./uploads')(Posts);

Posts.attachments = require('./attachments');


Posts.exists = async function (pids) {
	return await db.exists(
		Array.isArray(pids) ? pids.map(pid => `post:${pid}`) : `post:${pids}`
	);
};

Posts.getPidsFromSet = async function (set, start, stop, reverse) {
	if (isNaN(start) || isNaN(stop)) {
		return [];
	}
	return await db[reverse ? 'getSortedSetRevRange' : 'getSortedSetRange'](set, start, stop);
};

Posts.getPostsByPids = async function (pids, uid) {
	if (!Array.isArray(pids) || !pids.length) {
		return [];
	}

	let posts = await Posts.getPostsData(pids);
	posts = await Promise.all(posts.map(Posts.parsePost));
	const data = await plugins.hooks.fire('filter:post.getPosts', { posts: posts, uid: uid });
	if (!data || !Array.isArray(data.posts)) {
		return [];
	}
	return data.posts.filter(Boolean);
};

Posts.getPostSummariesFromSet = async function (set, uid, start, stop) {
	let pids = await db.getSortedSetRevRange(set, start, stop);
	pids = await privileges.posts.filter('topics:read', pids, uid);
	const posts = await Posts.getPostSummaryByPids(pids, uid, { stripTags: false });
	return { posts: posts, nextStart: stop + 1 };
};

Posts.getPidIndex = async function (pid, tid, topicPostSort) {
	const set = topicPostSort === 'most_votes' ? `tid:${tid}:posts:votes` : `tid:${tid}:posts`;
	const reverse = topicPostSort === 'newest_to_oldest' || topicPostSort === 'most_votes';
	const index = await db[reverse ? 'sortedSetRevRank' : 'sortedSetRank'](set, pid);
	if (!utils.isNumber(index)) {
		return 0;
	}
	return utils.isNumber(index) ? parseInt(index, 10) + 1 : 0;
};

Posts.getPostIndices = async function (posts, uid) {
	if (!Array.isArray(posts) || !posts.length) {
		return [];
	}
	const settings = await user.getSettings(uid);

	const byVotes = settings.topicPostSort === 'most_votes';
	let sets = posts.map(p => (byVotes ? `tid:${p.tid}:posts:votes` : `tid:${p.tid}:posts`));
	const reverse = settings.topicPostSort === 'newest_to_oldest' || settings.topicPostSort === 'most_votes';

	const uniqueSets = _.uniq(sets);
	let method = reverse ? 'sortedSetsRevRanks' : 'sortedSetsRanks';
	if (uniqueSets.length === 1) {
		method = reverse ? 'sortedSetRevRanks' : 'sortedSetRanks';
		sets = uniqueSets[0];
	}

	const pids = posts.map(post => post.pid);
	const indices = await db[method](sets, pids);
	return indices.map(index => (utils.isNumber(index) ? parseInt(index, 10) + 1 : 0));
};

Posts.modifyPostByPrivilege = function (post, privileges) {
	if (post && post.deleted && !(post.selfPost || privileges['posts:view_deleted'])) {
		post.content = '[[topic:post-is-deleted]]';
		if (post.user) {
			post.user.signature = '';
		}
	}
};

require('../promisify')(Posts);
