'use strict';

const nconf = require('nconf');

const db = require('../../database');
const posts = require('../../posts');
const flags = require('../../flags');
const events = require('../../events');
const privileges = require('../../privileges');
const plugins = require('../../plugins');
const social = require('../../social');
const user = require('../../user');
const utils = require('../../utils');
const websockets = require('../index');

module.exports = function (SocketPosts) {
	SocketPosts.loadPostTools = async function (socket, data) {
		if (!data || !data.pid) {
			throw new Error('[[error:invalid-data]]');
		}
		const cid = await posts.getCidByPid(data.pid);
		const results = await utils.promiseParallel({
			posts: posts.getPostFields(data.pid, ['deleted', 'bookmarks', 'uid', 'ip', 'flagId', 'url', 'answered']),
			isAdmin: user.isAdministrator(socket.uid),
			isGlobalMod: user.isGlobalModerator(socket.uid),
			isModerator: user.isModerator(socket.uid, cid),
			canEdit: privileges.posts.canEdit(data.pid, socket.uid),
			canDelete: privileges.posts.canDelete(data.pid, socket.uid),
			canPurge: privileges.posts.canPurge(data.pid, socket.uid),
			canFlag: privileges.posts.canFlag(data.pid, socket.uid),
			canViewHistory: privileges.posts.can('posts:history', data.pid, socket.uid),
			flagged: flags.exists('post', data.pid, socket.uid), // specifically, whether THIS calling user flagged
			bookmarked: posts.hasBookmarked(data.pid, socket.uid),
			postSharing: social.getActivePostSharing(),
			history: posts.diffs.exists(data.pid),
			canViewInfo: privileges.global.can('view:users:info', socket.uid),
		});

		const postData = results.posts;
		postData.pid = data.pid;
		postData.absolute_url = `${nconf.get('url')}/post/${encodeURIComponent(data.pid)}`;
		postData.bookmarked = results.bookmarked;
		postData.selfPost = socket.uid && socket.uid === postData.uid;
		postData.display_edit_tools = results.canEdit.flag;
		postData.display_delete_tools = results.canDelete.flag;
		postData.display_purge_tools = results.canPurge;
		postData.display_flag_tools = socket.uid && results.canFlag.flag;
		postData.display_moderator_tools = postData.display_edit_tools || postData.display_delete_tools;
		postData.display_move_tools = results.isAdmin || results.isModerator;
		postData.display_change_owner_tools = results.isAdmin || results.isModerator;
		postData.display_manage_editors_tools = results.isAdmin || results.isModerator || postData.selfPost;
		postData.display_ip_ban = (results.isAdmin || results.isGlobalMod) && !postData.selfPost;
		postData.display_history = results.history && results.canViewHistory;
		postData.display_original_url = !utils.isNumber(data.pid);
		postData.flags = {
			flagId: parseInt(results.posts.flagId, 10) || null,
			can: results.canFlag.flag,
			exists: !!results.posts.flagId,
			flagged: results.flagged,
			state: await db.getObjectField(`flag:${postData.flagId}`, 'state'),
		};

		if (!results.isAdmin && !results.canViewInfo) {
			postData.ip = undefined;
		}
		const { tools } = await plugins.hooks.fire('filter:post.tools', {
			pid: data.pid,
			post: postData,
			uid: socket.uid,
			tools: [],
		});
		postData.tools = tools;

		return results;
	};

	SocketPosts.changeOwner = async function (socket, data) {
		if (!data || !Array.isArray(data.pids) || !data.toUid) {
			throw new Error('[[error:invalid-data]]');
		}
		const isAdminOrGlobalMod = await user.isAdminOrGlobalMod(socket.uid);
		if (!isAdminOrGlobalMod) {
			throw new Error('[[error:no-privileges]]');
		}

		const postData = await posts.changeOwner(data.pids, data.toUid);
		const logs = postData.map(({ pid, uid, cid }) => (events.log({
			type: 'post-change-owner',
			uid: socket.uid,
			ip: socket.ip,
			targetUid: data.toUid,
			pid: pid,
			originalUid: uid,
			cid: cid,
		})));

		await Promise.all(logs);
	};

	SocketPosts.getEditors = async function (socket, data) {
		if (!data || !data.pid) {
			throw new Error('[[error:invalid-data]]');
		}
		await checkEditorPrivilege(socket.uid, data.pid);
		const editorUids = await db.getSetMembers(`pid:${data.pid}:editors`);
		const userData = await user.getUsersFields(editorUids, ['username', 'userslug', 'picture']);
		return userData;
	};

	SocketPosts.toggleAnswered = async function (socket, data) {
		if (!data || !data.pid) {
			throw new Error('[[error:invalid-data]]');
		}
		const {pid} = data;
		// enforce same privilege as flagging (visibility driven by canFlag)
		const canFlag = await privileges.posts.canFlag(pid, socket.uid);
		if (!canFlag || !canFlag.flag) {
			throw new Error('[[error:no-privileges]]');
		}

		// read current state and toggle
		const tid = await posts.getPostField(pid, 'tid');
		const current = await posts.getPostField(pid, 'answered');
		const newVal = !parseInt(current, 10);

		// Debug: log the toggle attempt for diagnosis
		try {
			console.log('[posts.toggleAnswered] pid=%s current=%s newVal=%s uid=%s', pid, current, newVal, socket && socket.uid);
		} catch (e) {
			// ignore logging errors
		}
		// If Posts.answered helper exists, use it. Otherwise fall back to direct DB ops.
		if (posts.answered && typeof posts.answered.set === 'function') {
			await posts.answered.set(pid, newVal);
		} else {
			// fallback: set post field and update sorted sets
			const tid = await posts.getPostField(pid, 'tid');
			await posts.setPostField(pid, 'answered', newVal ? 1 : 0);
			try {
				console.log('[posts.toggleAnswered] persisted fallback set post:%s.answered=%s', pid, newVal ? 1 : 0);
			} catch (e) {
				// ignore
			}
			if (newVal) {
				const score = Date.now();
				await db.sortedSetAdd('posts:answered', score, pid);
				await db.sortedSetAdd(`tid:${tid}:answered`, score, pid);
			} else {
				await db.sortedSetRemove('posts:answered', pid);
				await db.sortedSetRemove(`tid:${tid}:answered`, pid);
			}
		}

		// notify topic room so other clients can update in realtime
		try {
			if (tid) {
				websockets.in(`topic_${tid}`).emit('event:post_answered', { pid: pid, answered: newVal, tid });
				try { console.log('[posts.toggleAnswered] emitted event:post_answered to topic_%s payload=%j', tid, { pid: pid, answered: newVal, tid }); } catch (e) {}
			}
			// Also emit to the category room so category lists can update in realtime
			try {
				const cid = await posts.getCidByPid(pid);
				if (cid) {
					websockets.in(`category_${cid}`).emit('event:post_answered', { pid: pid, answered: newVal, tid, cid });
					try { console.log('[posts.toggleAnswered] emitted event:post_answered to category_%s payload=%j', cid, { pid: pid, answered: newVal, tid, cid }); } catch (e) {}
				}
			} catch (e) {
				// non-fatal
			}

			// Fire plugin hook for answered state change
			try {
				await plugins.hooks.fire('action:post.answered', { pid, answered: newVal, tid, uid: socket.uid });
			} catch (e) {
				// non-fatal
			}
		} catch (e) {
			// non-fatal
		}

		return { answered: newVal };
	};

	SocketPosts.saveEditors = async function (socket, data) {
		if (!data || !data.pid || !Array.isArray(data.uids)) {
			throw new Error('[[error:invalid-data]]');
		}
		await checkEditorPrivilege(socket.uid, data.pid);
		await db.delete(`pid:${data.pid}:editors`);
		await db.setAdd(`pid:${data.pid}:editors`, data.uids);
	};

	async function checkEditorPrivilege(uid, pid) {
		const cid = await posts.getCidByPid(pid);
		const [isAdminOrMod, owner] = await Promise.all([
			privileges.categories.isAdminOrMod(cid, uid),
			posts.getPostField(pid, 'uid'),
		]);
		const isSelfPost = String(uid) === String(owner);
		if (!isAdminOrMod && !isSelfPost) {
			throw new Error('[[error:no-privileges]]');
		}
	}
};
