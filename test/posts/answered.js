'use strict';

const assert = require('assert');

const db = require('../mocks/databasemock'); // <- up one level
const categories = require('../../src/categories'); // <- up two levels
const topics = require('../../src/topics');
const posts = require('../../src/posts');
const user = require('../../src/user');
const privileges = require('../../src/privileges');

describe('Posts: answered flag', () => {
	let ownerUid, otherUid, cid, tid, mainPid, replyPid;

	before(async () => {
		ownerUid = await user.create({ username: 'owner', password: '123456' });
		otherUid = await user.create({ username: 'other', password: '123456' });

		const cat = await categories.create({ name: 'AnsweredCat', description: '' });
		cid = cat.cid;

		const created = await topics.post({
			uid: ownerUid,
			cid,
			title: 'Answered topic',
			content: 'main post',
		});

		tid = created.topicData.tid;

		const reply = await topics.reply({
			uid: ownerUid,
			tid,
			content: 'reply post',
		});
		replyPid = reply.pid;
	});

	it('topic owner can mark a reply answered', async () => {
		const ok = await privileges.posts.canMarkAnswered(replyPid, ownerUid);
		assert.strictEqual(ok, true);

		const res = await posts.setAnswered(replyPid, true, ownerUid);
		assert.strictEqual(res.answered, 1);

		const answeredField = await posts.getPostField(replyPid, 'answered');
		assert.strictEqual(Number(answeredField), 1);

		const [globalHas, topicHas] = await Promise.all([
			db.isSortedSetMember('posts:answered', replyPid),
			db.isSortedSetMember(`tid:${tid}:answered`, replyPid),
		]);
		assert.strictEqual(globalHas, true);
		assert.strictEqual(topicHas, true);
	});

	it('random user cannot mark answered', async () => {
		const ok = await privileges.posts.canMarkAnswered(replyPid, otherUid);
		assert.strictEqual(ok, false);
	});

	it('delete removes from indices; restore re-adds if still answered', async () => {
		// delete
		await posts.delete(replyPid, ownerUid);
		const [gDel, tDel] = await Promise.all([
			db.isSortedSetMember('posts:answered', replyPid),
			db.isSortedSetMember(`tid:${tid}:answered`, replyPid),
		]);
		assert.strictEqual(gDel, false);
		assert.strictEqual(tDel, false);

		// restore
		await posts.restore(replyPid, ownerUid);

		const [gBack, tBack] = await Promise.all([
			db.isSortedSetMember('posts:answered', replyPid),
			db.isSortedSetMember(`tid:${tid}:answered`, replyPid),
		]);
		assert.strictEqual(gBack, true);
		assert.strictEqual(tBack, true);
	});

	it('unmark answered removes from indices', async () => {
		await posts.setAnswered(replyPid, false, ownerUid);
		const [gHas, tHas] = await Promise.all([
			db.isSortedSetMember('posts:answered', replyPid),
			db.isSortedSetMember(`tid:${tid}:answered`, replyPid),
		]);
		assert.strictEqual(gHas, false);
		assert.strictEqual(tHas, false);
		const fieldNow = await posts.getPostField(replyPid, 'answered');
		assert.strictEqual(Number(fieldNow), 0);
	});

	it('purge removes from indices as well', async () => {
		// mark again, then purge
		await posts.setAnswered(replyPid, true, ownerUid);
		await posts.purge(replyPid, ownerUid);

		const [gHas, tHas, exists] = await Promise.all([
			db.isSortedSetMember('posts:answered', replyPid),
			db.isSortedSetMember(`tid:${tid}:answered`, replyPid),
			posts.exists(replyPid),
		]);
		assert.strictEqual(gHas, false);
		assert.strictEqual(tHas, false);
		assert.strictEqual(Boolean(exists), false);
	});
});