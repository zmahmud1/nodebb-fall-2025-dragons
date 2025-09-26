'use strict';

define('topicList', [
	'forum/infinitescroll',
	'handleBack',
	'topicSelect',
	'categoryFilter',
	'tagFilter',
	'forum/category/tools',
	'hooks',
], function (infinitescroll, handleBack, topicSelect, categoryFilter, tagFilter, categoryTools, hooks) {
	const TopicList = {};
	let templateName = '';

	let newTopicCount = 0;
	let newPostCount = 0;

	let loadTopicsCallback;
	let topicListEl;

	const scheduledTopics = [];

	$(window).on('action:ajaxify.start', function () {
		TopicList.removeListeners();
		categoryTools.removeListeners();
	});

	TopicList.init = function (template, cb) {
		// Listen for answered events so category/topic lists update live
		socket.on('event:post_answered', function (data) {
			try {
				// DEBUG: Log receipt of answered events on category/topic lists
				console.log('[topicList] socket event:post_answered received', data);
				if (!data) return;
				// If tid present, prefer to fetch authoritative teaser from the server
				const tid = data.tid;
				// Always revalidate from DB: fetch teaser by tid or post by pid and update from DB-backed state
				if (tid) {
					fetch(config.relative_path + '/api/topic/teaser/' + tid, { credentials: 'same-origin' })
						.then(function (res) { if (!res.ok) throw new Error('teaser fetch failed'); return res.json(); })
						.then(function (body) {
							if (body && body.teaser) {
								updateAnsweredBadgeForTopic(tid, !!body.teaser.answered);
							}
						})
						.catch(function (err) {
							console.warn('[topicList] teaser fetch failed for tid=', tid, err);
						});
					return;
				} else if (data && data.pid) {
					fetch(config.relative_path + '/api/post/' + data.pid, { credentials: 'same-origin' })
						.then(function (res) { if (!res.ok) throw new Error('post fetch failed'); return res.json(); })
						.then(function (body) {
							if (body && body.post && body.post.tid) {
								updateAnsweredBadgeForTopic(body.post.tid, !!body.post.answered);
							}
						})
						.catch(function (err) {
							console.warn('[topicList] post fetch failed for pid=', data.pid, err);
						});
					return;
				}
				let topicEl = null;
				if (tid) {
					// Try to find the topic list item by a data-tid attribute on the root element.
					topicEl = topicListEl.find('[component="category/topic"][data-tid="' + tid + '"]');
					if ((!topicEl || !topicEl.length)) {
						// Fallback: find any element inside the topic list that has data-tid and climb up to the topic item.
						const inner = topicListEl.find('[data-tid="' + tid + '"]');
						if (inner && inner.length) {
							topicEl = inner.closest('[component="category/topic"]');
						}
					}
				}
				// As a fallback, search for topic elements whose teaser had the pid in a data attribute
				if ((!topicEl || !topicEl.length) && data.pid) {
					// Normalize pid/string 'null' handling: some templates set data-teaser-pid to 'null' or omit it.
					const pid = String(data.pid);
					topicEl = topicListEl.find('[component="category/topic"]').filter(function () {
						const attr = $(this).attr('data-teaser-pid');
						return attr && attr === pid;
					});
				}
				if (!topicEl || !topicEl.length) {
					// If we couldn't map the event to a DOM element, re-query the server
					// for DB-backed teaser/post state and update accordingly. This makes
					// the badge reflect persistent DB state even when DOM attributes
					// (data-teaser-pid) are missing or incorrect.
					if (tid) {
						fetch(config.relative_path + '/api/topic/teaser/' + tid, { credentials: 'same-origin' })
							.then(function (res) { if (!res.ok) throw new Error('teaser fetch failed'); return res.json(); })
							.then(function (body) {
								if (body && body.teaser) {
									updateAnsweredBadgeForTopic(tid, !!body.teaser.answered);
								}
							})
							.catch(function (err) {
								console.warn('[topicList] teaser fetch failed for tid=', tid, err);
							});
					} else if (data && data.pid) {
						fetch(config.relative_path + '/api/post/' + data.pid, { credentials: 'same-origin' })
							.then(function (res) { if (!res.ok) throw new Error('post fetch failed'); return res.json(); })
							.then(function (body) {
								if (body && body.post) {
									// Try to find the topic id from the returned post and update that
									if (body.post.tid) {
										updateAnsweredBadgeForTopic(body.post.tid, !!body.post.answered);
									}
								}
							})
							.catch(function (err) {
								console.warn('[topicList] post fetch failed for pid=', data.pid, err);
							});
					}
					return;
				}
				// Diagnostic: log what we matched
				console.log('[topicList] matched topicEl count=', (topicEl && topicEl.length) ? topicEl.length : 0, ' for tid=', tid, ' pid=', data.pid);
				// remove any existing badges inside this topic element
				const removed = topicEl.find('.post-answered-badge').remove();
				console.log('[topicList] removed existing badges count=', removed ? removed.length : 0);
				if (data.answered) {
					// Primary: the topic labels timeago (this is the timestamp displayed next to the
					// title). This ensures the badge appears underneath the title beside that timestamp.
					let timeEl = topicEl.find('[component="topic/labels"] .timeago').first();
					if (!timeEl || !timeEl.length) {
						// Secondary: header parent area (older themes place timeago as a sibling of header)
						const headerEl = topicEl.find('[component="topic/header"]').first();
						if (headerEl && headerEl.length) {
							timeEl = headerEl.parent().find('.timeago').first();
						}
					}
					if (!timeEl || !timeEl.length) {
						// Tertiary: teaser area then any timeago
						timeEl = topicEl.find('.meta.teaser .timeago').first();
					}
					if (!timeEl || !timeEl.length) {
						timeEl = topicEl.find('.timeago').first();
					}
					if (timeEl && timeEl.length) {
						timeEl.after('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
						console.log('[topicList] inserted badge after timeEl for tid=', tid);
					} else if (topicEl.find('[component="topic/header"]').length) {
						// Final fallback: append to header element
						topicEl.find('[component="topic/header"]').append('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
						console.log('[topicList] appended badge to header for tid=', tid);
					} else {
						// Very final fallback: append to the root topic element
						topicEl.append('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
						console.log('[topicList] appended badge to root for tid=', tid);
					}
				}

				/**
				 * Update badge DOM for a given tid based on answered boolean.
				 * Exposed locally to allow the DB-backed fetch to call it.
				 */
				function updateAnsweredBadgeForTopic(tidToUpdate, answered) {
					try {
						const el = topicListEl.find('[component="category/topic"][data-tid="' + tidToUpdate + '"]');
						if (!el || !el.length) return;
						el.find('.post-answered-badge').remove();
						if (answered) {
							let timeEl = el.find('[component="topic/labels"] .timeago').first();
							if (!timeEl || !timeEl.length) {
								const headerEl = el.find('[component="topic/header"]').first();
								if (headerEl && headerEl.length) {
									timeEl = headerEl.parent().find('.timeago').first();
								}
							}
							if (!timeEl || !timeEl.length) {
								timeEl = el.find('.meta.teaser .timeago').first();
							}
							if (!timeEl || !timeEl.length) {
								timeEl = el.find('.timeago').first();
							}
							if (timeEl && timeEl.length) {
								timeEl.after('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
							} else if (el.find('[component="topic/header"]').length) {
								el.find('[component="topic/header"]').append('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
							} else {
								el.append('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
							}
						}
					} catch (e) {
						console.error('[topicList] updateAnsweredBadgeForTopic error', e);
					}
				}
			} catch (e) {
				console.error('Error updating topic list for answered event', e);
			}
		});

		topicListEl = findTopicListElement();

		templateName = template;
		loadTopicsCallback = cb || loadTopicsAfter;

		categoryTools.init();

		TopicList.watchForNewPosts();
		const states = ['watching', 'tracking'];
		if (ajaxify.data.selectedFilter && ajaxify.data.selectedFilter.filter === 'watched') {
			states.push('notwatching', 'ignoring');
		} else if (template !== 'unread') {
			states.push('notwatching');
		}

		categoryFilter.init($('[component="category/dropdown"]'), {
			states: states,
		});

		tagFilter.init($('[component="tag/filter"]'));

		if (!config.usePagination) {
			infinitescroll.init(TopicList.loadMoreTopics);
		}

		handleBack.init(function (after, handleBackCallback) {
			loadTopicsCallback(after, 1, function (data, loadCallback) {
				onTopicsLoaded(templateName, data.topics, ajaxify.data.showSelect, 1, function () {
					handleBackCallback();
					loadCallback();
				});
			});
		});

		if ($('body').height() <= $(window).height() && topicListEl.children().length >= 20) {
			$('#load-more-btn').show();
		}

		$('#load-more-btn').on('click', function () {
			TopicList.loadMoreTopics(1);
		});

		hooks.fire('action:topics.loaded', { topics: ajaxify.data.topics });
	};

	function findTopicListElement() {
		return $('[component="category"]').filter(function (i, e) {
			return !$(e).parents('[widget-area],[data-widget-area]').length;
		});
	}

	TopicList.watchForNewPosts = function () {
		newPostCount = 0;
		newTopicCount = 0;
		TopicList.removeListeners();
		socket.on('event:new_topic', onNewTopic);
		socket.on('event:new_post', onNewPost);
	};

	TopicList.removeListeners = function () {
		socket.removeListener('event:new_topic', onNewTopic);
		socket.removeListener('event:new_post', onNewPost);
	};

	function onNewTopic(data) {
		const d = ajaxify.data;

		const categories = d.selectedCids &&
			d.selectedCids.length &&
			d.selectedCids.indexOf(parseInt(data.cid, 10)) === -1;
		const filterWatched = d.selectedFilter &&
			d.selectedFilter.filter === 'watched';
		const category = d.template.category &&
			parseInt(d.cid, 10) !== parseInt(data.cid, 10);

		const preventAlert = !!(categories || filterWatched || category || scheduledTopics.includes(data.tid));
		hooks.fire('filter:topicList.onNewTopic', { topic: data, preventAlert }).then((result) => {
			if (result.preventAlert) {
				return;
			}

			if (data.scheduled && data.tid) {
				scheduledTopics.push(data.tid);
			}
			newTopicCount += 1;
			updateAlertText();
		});
	}

	function onNewPost(data) {
		const post = data.posts[0];
		if (!post || !post.topic || post.topic.isFollowing) {
			return;
		}

		const d = ajaxify.data;

		const isMain = parseInt(post.topic.mainPid, 10) === parseInt(post.pid, 10);
		const categories = d.selectedCids &&
			d.selectedCids.length &&
			d.selectedCids.indexOf(parseInt(post.topic.cid, 10)) === -1;
		const filterNew = d.selectedFilter &&
			d.selectedFilter.filter === 'new';
		const filterWatched = d.selectedFilter &&
			d.selectedFilter.filter === 'watched' &&
			!post.topic.isFollowing;
		const category = d.template.category &&
			parseInt(d.cid, 10) !== parseInt(post.topic.cid, 10);

		const preventAlert = !!(isMain || categories || filterNew || filterWatched || category);
		hooks.fire('filter:topicList.onNewPost', { post, preventAlert }).then((result) => {
			if (result.preventAlert) {
				return;
			}

			newPostCount += 1;
			updateAlertText();
		});
	}

	function updateAlertText() {
		if (newTopicCount > 0 || newPostCount > 0) {
			$('#new-topics-alert').removeClass('hide').fadeIn('slow');
			$('#category-no-topics').addClass('hide');
		}
	}

	TopicList.loadMoreTopics = function (direction) {
		if (!topicListEl.length || !topicListEl.children().length) {
			return;
		}
		const topics = topicListEl.find('[component="category/topic"]');
		const afterEl = direction > 0 ? topics.last() : topics.first();
		const after = (parseInt(afterEl.attr('data-index'), 10) || 0) + (direction > 0 ? 1 : 0);

		if (!utils.isNumber(after) || (after === 0 && topicListEl.find('[component="category/topic"][data-index="0"]').length)) {
			return;
		}

		loadTopicsCallback(after, direction, function (data, done) {
			onTopicsLoaded(templateName, data.topics, ajaxify.data.showSelect, direction, done);
		});
	};

	function calculateNextPage(after, direction) {
		return Math.floor(after / config.topicsPerPage) + (direction > 0 ? 1 : 0);
	}

	function loadTopicsAfter(after, direction, callback) {
		callback = callback || function () {};
		const query = utils.params();
		query.page = calculateNextPage(after, direction);
		infinitescroll.loadMoreXhr(query, callback);
	}

	function filterTopicsOnDom(topics) {
		return topics.filter(function (topic) {
			return !topicListEl.find('[component="category/topic"][data-tid="' + topic.tid + '"]').length;
		});
	}

	function onTopicsLoaded(templateName, topics, showSelect, direction, callback) {
		if (!topics || !topics.length) {
			$('#load-more-btn').hide();
			return callback();
		}
		topics = filterTopicsOnDom(topics);

		if (!topics.length) {
			$('#load-more-btn').hide();
			return callback();
		}

		let after;
		let before;
		const topicEls = topicListEl.find('[component="category/topic"]');

		if (direction > 0 && topics.length) {
			after = topicEls.last();
		} else if (direction < 0 && topics.length) {
			before = topicEls.first();
		}

		const tplData = {
			topics: topics,
			showSelect: showSelect,
			template: {
				name: templateName,
			},
		};
		tplData.template[templateName] = true;

		hooks.fire('action:topics.loading', { topics: topics, after: after, before: before });

		app.parseAndTranslate(templateName, 'topics', tplData, function (html) {
			topicListEl.removeClass('hidden');
			$('#category-no-topics').remove();

			if (after && after.length) {
				html.insertAfter(after);
			} else if (before && before.length) {
				const height = $(document).height();
				const scrollTop = $(window).scrollTop();

				html.insertBefore(before);

				$(window).scrollTop(scrollTop + ($(document).height() - height));
			} else {
				topicListEl.append(html);
			}

			if (!topicSelect.getSelectedTids().length) {
				infinitescroll.removeExtra(topicListEl.find('[component="category/topic"]'), direction, Math.max(60, config.topicsPerPage * 3));
			}

			html.find('.timeago').timeago();
			hooks.fire('action:topics.loaded', { topics: topics, template: templateName });

			// Insert ANSWERED badges for topic list teasers when appropriate.
			try {
				topics.forEach(function (topic) {
					if (!topic || !topic.tid) return;
					const teaser = topic.teaser || {};
					if (teaser.answered && teaser.answered !== '0' && teaser.answered !== 0) {
						const topicEl = topicListEl.find('[component="category/topic"][data-tid="' + topic.tid + '"]');
						if (!topicEl.length) return;
						// Avoid duplicate badges
						topicEl.find('.post-answered-badge').remove();
						// Prefer the topic header timeago (timestamp after the title), then teaser area, then any timeago
						let timeEl = topicEl.find('[component="topic/header"] .timeago').first();
						if (!timeEl || !timeEl.length) {
							timeEl = topicEl.find('.meta.teaser .timeago').first();
						}
						if (!timeEl || !timeEl.length) {
							timeEl = topicEl.find('.timeago').first();
						}
						if (timeEl && timeEl.length) {
							timeEl.after('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
						} else if (topicEl.find('[component="topic/header"]').length) {
							// Final fallback: append to header element
							topicEl.find('[component="topic/header"]').append('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
						} else {
							// Very final fallback: append to the root topic element
							topicEl.append('<span class="ms-2 text-success fw-bold post-answered-badge">ANSWERED</span>');
						}
					}
				});
			} catch (e) {
				console.error('Error inserting answered badges in topic list', e);
			}
			callback();
		});
	}

	return TopicList;
});
