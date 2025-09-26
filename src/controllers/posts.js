'use strict';

const nconf = require('nconf');
const querystring = require('querystring');

const meta = require('../meta');
const posts = require('../posts');
const privileges = require('../privileges');
const activitypub = require('../activitypub');
const utils = require('../utils');

const helpers = require('./helpers');

const postsController = module.exports;

postsController.redirectToPost = async function (req, res, next) {
	const pid = utils.isNumber(req.params.pid) ? parseInt(req.params.pid, 10) : req.params.pid;
	if (!pid) {
		return next();
	}

	// Kickstart note assertion if applicable
	if (!utils.isNumber(pid) && req.uid && meta.config.activitypubEnabled) {
		const exists = await posts.exists(pid);
		if (!exists) {
			await activitypub.notes.assert(req.uid, pid);
		}
	}

	const [canRead, path] = await Promise.all([
		privileges.posts.can('topics:read', pid, req.uid),
		posts.generatePostPath(pid, req.uid),
	]);
	if (!path) {
		return next();
	}
	if (!canRead) {
		return helpers.notAllowed(req, res);
	}

	if (meta.config.activitypubEnabled) {
		// Include link header for richer parsing
		res.set('Link', `<${nconf.get('url')}/post/${req.params.pid}>; rel="alternate"; type="application/activity+json"`);
	}

	const qs = querystring.stringify(req.query);
	helpers.redirect(res, qs ? `${path}?${qs}` : path, true);
};

postsController.getRecentPosts = async function (req, res) {
	const page = parseInt(req.query.page, 10) || 1;
	const postsPerPage = 20;
	const start = Math.max(0, (page - 1) * postsPerPage);
	const stop = start + postsPerPage - 1;
	const data = await posts.getRecentPosts(req.uid, start, stop, req.params.term);
	res.json(data);
};

// Toggle post.answered (admin/mod/topic owner/post owner)
postsController.toggleAnswered = async function (req, res) {
	const pidRaw = req.params.pid;
	const pid = utils.isNumber(pidRaw) ? parseInt(pidRaw, 10) : pidRaw;

	// accept true/false, "true"/"false", 1/0, "1"/"0"
	const raw = req.body && req.body.answered;
	const answered = raw === true || raw === 'true' || raw === 1 || raw === '1';

	if (!req.uid) {
		throw new Error('[[error:not-logged-in]]');
	}

	const ok = await privileges.posts.canMarkAnswered(pid, req.uid);
	if (!ok) {
		throw new Error('[[error:no-privileges]]');
	}

	// Persist + maintain indices (requires you implemented posts.setAnswered)
	await posts.setAnswered(pid, answered, req.uid);

	const fields = await posts.getPostFields(pid, ['pid', 'tid', 'answered']);
	const payload = {
		pid: fields.pid,
		tid: fields.tid,
		answered: Number(fields.answered) === 1,
		uid: req.uid,
	};

	// Live-update anyone on the topic page
	require('../socket.io').in(`topic_${payload.tid}`).emit('event:post_answered_toggled', payload);

	res.json({ status: 'ok', ...payload });
};