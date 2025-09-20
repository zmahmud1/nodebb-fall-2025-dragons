'use strict';

const assert = require('assert');

const db = require('../mocks/databasemock'); // initializes mock db & env
const plugins = require('../../src/plugins');
const categories = require('../../src/categories');
const topics = require('../../src/topics');
const posts = require('../../src/posts');
const user = require('../../src/user');

describe('topics/posts addEventStartEnd (integration)', () => {
	let uid, tid, mainPid, replyPid;

	before(async () => {
		uid = await user.create({ username: 'cover-user', password: '123456' });

		const cat = await categories.create({
			name: 'Coverage Cat',
			description: 'for posts.js coverage',
		});

		const created = await topics.post({
			title: 'coverage thread',
			content: 'main post',
			uid,
			cid: cat.cid,
		});

		tid = created.topicData.tid;
		mainPid = created.postData.pid;

		// small delay so timestamps differ
		await new Promise(r => setTimeout(r, 5));

		const reply = await posts.create({
			uid,
			tid,
			content: 'first reply',
		});
		replyPid = reply.pid;
	});

	it('forward order (reverse=false): eventStart/eventEnd are set for main+reply', async () => {
		// start=0, stop=2 => expect main (index 0) and one reply (index 1)
		const out = await topics.getTopicPosts(
			await topics.getTopicData(tid),
			`tid:${tid}:posts`,
			0,
			2,
			uid,
			false
		);

		assert(Array.isArray(out));
		assert(out.length >= 2);

		// main post should have eventStart/eventEnd (end should be ~ next post ts)
		assert.ok(out[0].eventStart !== undefined);
		assert.ok(out[0].eventEnd !== undefined);

		// reply should also have eventStart/eventEnd
		assert.ok(out[1].eventStart !== undefined);
		assert.ok(out[1].eventEnd !== undefined);
	});

	it('reverse order (reverse=true): eventStart/eventEnd set from lastposttime↔now', async () => {
		const out = await topics.getTopicPosts(
			await topics.getTopicData(tid),
			`tid:${tid}:posts`,
			0,
			2,
			uid,
			true
		);

		assert(Array.isArray(out));
		assert(out.length >= 2);

		// whichever is first in reverse should still have the computed window
		assert.ok(out[0].eventStart !== undefined);
		assert.ok(out[0].eventEnd !== undefined);
	});

	it('lastPost.index path: ensures non-zero index triggers next-score lookup', async () => {
		// Ask just for the reply so that it's "last" and has index=1 (truthy)
		const out = await topics.getTopicPosts(
			await topics.getTopicData(tid),
			`tid:${tid}:posts`,
			1, // start replies
			2,
			uid,
			false
		);

		assert(Array.isArray(out));
		assert(out.length >= 1);

		// last element's eventEnd should be present; mock db supplies a score
		const last = out[out.length - 1];
		assert.ok(last.eventEnd !== undefined);
	});

	it('calculatePostIndices ticks function coverage', () => {
		const arr = [{}, {}, {}];
		topics.calculatePostIndices(arr, 5);
		assert.deepStrictEqual(arr.map(p => p.index), [6, 7, 8]);
	});

	it('getLatestUndeletedPid returns mainPid when no replies exist', async () => {
		// Create a new topic with just a main post
		const created = await topics.post({
			title: 'undeleted check',
			content: 'main only',
			uid,
			cid: 1,
		});
		const tid = created.topicData.tid;
		const mainPid = created.postData.pid;

		const pid = await topics.getLatestUndeletedPid(tid);
		assert.strictEqual(pid, mainPid);
	});
});