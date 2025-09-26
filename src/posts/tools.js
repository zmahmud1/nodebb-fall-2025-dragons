'use strict';

const db = require('../database');
const plugins = require('../plugins');
const privileges = require('../privileges');

module.exports = function (Posts) {
	Posts.tools = {};

	Posts.tools.delete = async function (uid, pid) {
		return await togglePostDelete(uid, pid, true);
	};

	Posts.tools.restore = async function (uid, pid) {
		return await togglePostDelete(uid, pid, false);
	};

	Posts.tools.pin = async function (uid, pid) {
		return await togglePostPin(uid, pid, true);
	};

	Posts.tools.unpin = async function (uid, pid) {
		return await togglePostPin(uid, pid, false);
	};

	async function togglePostDelete(uid, pid, isDelete) {
		const [postData, canDelete] = await Promise.all([
			Posts.getPostData(pid),
			privileges.posts.canDelete(pid, uid),
		]);
		if (!postData) {
			throw new Error('[[error:no-post]]');
		}

		if (postData.deleted && isDelete) {
			throw new Error('[[error:post-already-deleted]]');
		} else if (!postData.deleted && !isDelete) {
			throw new Error('[[error:post-already-restored]]');
		}

		if (!canDelete.flag) {
			throw new Error(canDelete.message);
		}
		let post;
		if (isDelete) {
			Posts.clearCachedPost(pid);
			post = await Posts.delete(pid, uid);
		} else {
			post = await Posts.restore(pid, uid);
			post = await Posts.parsePost(post);
		}
		return post;
	}

	async function togglePostPin(uid, pid, pin) {
		const [postData, isAdmin] = await Promise.all([
			Posts.getPostFields(pid, ['pid', 'tid', 'pinned']),
			privileges.users.isAdministrator(uid),
		]);
		if (!postData || !postData.pid) {
			throw new Error('[[error:no-post]]');
		}
		if (!isAdmin) {
			throw new Error('[[error:no-privileges]]');
		}

		await Posts.setPostField(pid, 'pinned', pin ? 1 : 0);

		// Optional: keep a per-topic pinned posts zset for fast retrieval
		if (postData.tid) {
			if (pin) {
				await db.sortedSetAdd(`tid:${postData.tid}:pids:pinned`, Date.now(), String(pid));
			} else {
				await db.sortedSetRemove(`tid:${postData.tid}:pids:pinned`, String(pid));
			}
		}

		const payload = {
			post: { ...postData, pinned: pin ? 1 : 0 },
			uid,
			pinned: !!pin,
		};
		plugins.hooks.fire('action:post.pin', payload);
		return payload.post;
	}
};
