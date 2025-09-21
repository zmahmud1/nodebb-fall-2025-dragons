'use strict';

const express = require('express');

const uploadsController = require('../controllers/uploads');
const helpers = require('./helpers');
// const postsAPI = require('../api/posts');
const posts = require('../posts');

module.exports = function (app, middleware, controllers) {
	const middlewares = [middleware.autoLocale, middleware.authenticateRequest];
	const router = express.Router();
	app.use('/api', router);

	router.get('/config', [...middlewares, middleware.applyCSRF], helpers.tryRoute(controllers.api.getConfig));

	router.get('/self', [...middlewares], helpers.tryRoute(controllers.user.getCurrentUser));
	router.get('/user/uid/:uid', [...middlewares, middleware.canViewUsers], helpers.tryRoute(controllers.user.getUserByUID));
	router.get('/user/username/:username', [...middlewares, middleware.canViewUsers], helpers.tryRoute(controllers.user.getUserByUsername));
	router.get('/user/email/:email', [...middlewares, middleware.canViewUsers], helpers.tryRoute(controllers.user.getUserByEmail));

	router.get('/categories/:cid/moderators', [...middlewares], helpers.tryRoute(controllers.api.getModerators));
	router.get('/recent/posts/:term?', [...middlewares], helpers.tryRoute(controllers.posts.getRecentPosts));
	router.get('/unread/total', [...middlewares, middleware.ensureLoggedIn], helpers.tryRoute(controllers.unread.unreadTotal));
	router.get('/topic/teaser/:topic_id', [...middlewares], helpers.tryRoute(controllers.topics.teaser));
	router.get('/topic/pagination/:topic_id', [...middlewares], helpers.tryRoute(controllers.topics.pagination));

	const multipart = require('connect-multiparty');
	const multipartMiddleware = multipart();
	const postMiddlewares = [
		middleware.maintenanceMode,
		multipartMiddleware,
		middleware.validateFiles,
		middleware.uploads.ratelimit,
		middleware.applyCSRF,
	];

	router.post('/post/upload', postMiddlewares, helpers.tryRoute(uploadsController.uploadPost));
	router.post('/user/:userslug/uploadpicture', [
		...middlewares,
		...postMiddlewares,
		middleware.exposeUid,
		middleware.ensureLoggedIn,
		middleware.canViewUsers,
		middleware.checkAccountPermissions,
	], helpers.tryRoute(controllers.accounts.edit.uploadPicture));

	// src/routes/api.js
	// ...
	// Mark a reply as answered
	router.post(
		'/posts/:pid/answered',
		[...middlewares, middleware.ensureLoggedIn, middleware.applyCSRF],
		async (req, res, next) => {
			try {
				console.log('[answered] POST hit pid=%s uid=%s', req.params.pid, req.uid);
				// If you implemented Posts.setAnswered, you can use it instead:
				// const out = await posts.setAnswered(req.params.pid, true, req.uid);
				await posts.answered.mark(req.params.pid, req.uid);
				console.log('[answered] POST resolved pid=%s', req.params.pid);
				res.json({ ok: true, pid: Number(req.params.pid), answered: true });
			} catch (err) {
				console.error('[answered] POST error', err);
				next(err);
			}
		}
	);

	// Unmark
	router.delete(
		'/posts/:pid/answered',
		[...middlewares, middleware.ensureLoggedIn, middleware.applyCSRF],
		async (req, res, next) => {
			try {
				console.log('[answered] DELETE hit pid=%s uid=%s', req.params.pid, req.uid);
				// const out = await posts.setAnswered(req.params.pid, false, req.uid);
				await posts.answered.unmark(req.params.pid, req.uid);
				console.log('[answered] DELETE resolved pid=%s', req.params.pid);
				res.json({ ok: true, pid: Number(req.params.pid), answered: false });
			} catch (err) {
				console.error('[answered] DELETE error', err);
				next(err);
			}
		}
	);
};
