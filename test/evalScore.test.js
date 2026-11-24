// Tests for the eval scorer (eval/score.js). It imports nothing from src/, so no .env, key or model is involved.
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { wilson, analyzeLogs, normalize, tokens, hasFact, findCollisions, isRefusal, isSoftRefusal, chanceHitAll, scoreQuestion, summarizeGroup, chunkHit } from '../eval/score.js';

test('normalize: digits, separators and Arabic spellings', () => {
  assert.equal(normalize('٢٢٬٠٠٠ ريال'), '22000 ريال');
  assert.equal(normalize('22,000 SAR'), '22000 sar');
  assert.equal(normalize('1,5 and 1.5'), '1,5 and 1.5');
  assert.equal(normalize('إِجَازَة'), 'اجازه');
  assert.equal(normalize('مدرسة'), normalize('مدرسه'));
});

test('tokens: attached letters and times split cleanly', () => {
  // A full hour (":00") is the same as the bare hour, so "9:00 pm" and "9 pm" compare equal.
  assert.deepEqual(tokens('ب30 يوما، 10:00-21:00'), ['ب', '30', 'يوما', '10', '21']);
  assert.deepEqual(tokens('9:30 and 9:00'), ['9', '30', 'and', '9']);
  assert.deepEqual(tokens('192.168.8.1'), ['192.168', '8.1']);
});

test('hasFact: whole tokens only, never raw substrings', () => {
  assert.equal(hasFact('You may leave at noon.', ['may']), true);
  assert.equal(hasFact('That is maybe true.', ['may']), false);
  assert.equal(hasFact('It lasts 180 days.', ['18']), false);
  assert.equal(hasFact('It lasts 18 days.', ['18']), true);
  assert.equal(hasFact('It costs 21.5 dollars.', ['1.5']), false);
  assert.equal(hasFact('It costs 1.5 dollars.', ['1.5']), true);
  assert.equal(hasFact('Fee: 22,000 SAR', ['22000']), true);
  assert.equal(hasFact('The reset takes twelve seconds', ['12', 'twelve']), true);
  assert.equal(hasFact('There is no internet connection.', ['no internet']), true);
  assert.equal(hasFact('Closes at 9:00 PM', ['9 pm']), true);
  assert.equal(hasFact('Closes at 9:15 PM', ['9 pm']), false);
});

test('hasFact: Arabic prefixes only on the answer side, never stripped on their own', () => {
  assert.equal(hasFact('الكتاب مفيد', ['كتاب']), true);
  assert.equal(hasFact('بالكتاب', ['كتاب']), true);
  assert.equal(hasFact('هذا تاب', ['كتاب']), false);
  assert.equal(hasFact('هذا مدرس', ['مدرسة']), false);
  assert.equal(hasFact('هذه مدرسة', ['مدرسة']), true);
  assert.equal(hasFact('خلال ٢٤ ساعة', ['24']), true);
  assert.equal(hasFact('لمدة 10 سنوات', ['10 سنوات']), true);
  assert.equal(hasFact('', ['24']), false);
  assert.equal(hasFact('24', ['']), false);
});

test('refusal detection: the exact sentence versus loose phrases', () => {
  const sentence = "I couldn't find that in your uploaded documents.";
  assert.equal(isRefusal(sentence, sentence), true);
  assert.equal(isRefusal('The answer is 24 days.', sentence), false);
  assert.equal(isRefusal(`The document says: ${sentence}`, sentence), false);
  assert.equal(isRefusal(`${sentence} `, sentence), true);
  assert.equal(isSoftRefusal('The documents do not mention dental insurance.'), true);
  assert.equal(isSoftRefusal('لم أجد هذه المعلومة في المستندات'), true);
  assert.equal(isSoftRefusal('لا يوجد ذكر للتقسيط في دليل العيادة'), true);
  assert.equal(isSoftRefusal('The leave is 24 days.'), false);
});

test('chanceHitAll: random top-k baseline', () => {
  // 10 chunks, 2 belong to the file, 4 drawn: 1 - C(8,4)/C(10,4) = 2/3
  assert.ok(Math.abs(chanceHitAll(['a'], { a: 2, b: 8 }, 4) - 2 / 3) < 1e-9);
  // two files with 1 chunk each out of 4 chunks, k = 4: both are always drawn
  assert.ok(Math.abs(chanceHitAll(['a', 'b'], { a: 1, b: 1, c: 2 }, 4) - 1) < 1e-9);
  // k = 2 of 4, two files with 1 chunk each: P(both) = 1/C(4,2) = 1/6
  assert.ok(Math.abs(chanceHitAll(['a', 'b'], { a: 1, b: 1, c: 2 }, 2) - 1 / 6) < 1e-9);
});

const NOT_FOUND = "I couldn't find that in your uploaded documents.";
const hr = { id: 'q', sources: ['hr.txt'], facts: [['24']] };

test('scoreQuestion: a correct, cited answer', () => {
  const run = { retrieved: [{ source: 'hr.txt', score: 0.6 }], answer: '24 days.', sources: [{ source: 'hr.txt' }], chance: 0.5 };
  const r = scoreQuestion(hr, run, NOT_FOUND);
  assert.deepEqual([r.retrievalAll, r.retrievalTop1, r.citedAll, r.correct, r.refused], [true, true, true, true, false]);
});

test('scoreQuestion: a false refusal is wrong, an error is not scored', () => {
  const refused = scoreQuestion(hr, { retrieved: [{ source: 'x.txt', score: 0.2 }], answer: NOT_FOUND, sources: [] }, NOT_FOUND);
  assert.deepEqual([refused.retrievalAny, refused.correct, refused.refused], [false, false, true]);
  const errored = scoreQuestion(hr, { retrieved: [], error: { code: 'LLM_RATE_LIMIT' } }, NOT_FOUND);
  assert.equal(errored.errored, true);
  assert.equal(errored.correct, undefined);
});

test('scoreQuestion: unanswerable needs the exact sentence and no sources', () => {
  const none = { id: 'n', sources: [], facts: [] };
  assert.equal(scoreQuestion(none, { retrieved: [], answer: NOT_FOUND, sources: [] }, NOT_FOUND).refusedCorrectly, true);
  const loose = scoreQuestion(none, { retrieved: [], answer: 'The documents do not mention it.', sources: [] }, NOT_FOUND);
  assert.deepEqual([loose.refusedCorrectly, loose.softRefused], [false, true]);
  assert.equal(scoreQuestion(none, { retrieved: [], answer: 'Paris.', sources: [{ source: 'a.txt' }] }, NOT_FOUND).refusedCorrectly, false);
});

test('summarizeGroup: errors are excluded from answer scores and counted', () => {
  const rows = [
    { answerable: true, retrievalAll: true, retrievalAny: true, retrievalTop1: true, citedAll: true, correct: true, factRecall: 1, refused: false, topScore: 0.6, chance: 0.5 },
    { answerable: true, retrievalAll: false, retrievalAny: false, retrievalTop1: false, errored: true, topScore: 0.2, chance: 0.5 },
  ];
  const s = summarizeGroup(rows);
  assert.equal(s.errored, 1);
  assert.equal(s.retrievalAll, 0.5);
  assert.equal(s.correct, 1);
  assert.equal(s.answeredCount, 1);
});

test('retrieval-only: a record with no answer carries no answer scores, and summaries show null', () => {
  const run = { retrieved: [{ source: 'hr.txt', score: 0.6 }], chance: 0.5, chanceTop1: 0.2 };
  const record = scoreQuestion(hr, run, NOT_FOUND);
  assert.equal(record.retrievalAll, true);
  for (const key of ['refused', 'softRefused', 'correct', 'citedAll', 'factRecall', 'factsFound']) assert.equal(key in record, false, key);
  const none = scoreQuestion({ id: 'n', sources: [], facts: [] }, { retrieved: [] }, NOT_FOUND);
  assert.equal('refusedCorrectly' in none, false);
  const s = summarizeGroup([record, none]);
  assert.equal(s.answeredCount, 0);
  assert.equal(s.unansweredCount, 0);
  assert.equal(s.correct, null);
  assert.equal(s.factRecall, null);
  assert.equal(s.refused, null);
  assert.equal(s.retrievalAll, 1);
});

test('normalize: times, thousands separators, spelled numbers, currency (false fails reported by review)', () => {
  assert.equal(hasFact('The branch closes at 9:00 p.m.', ['9 pm']), true);
  assert.equal(hasFact('The branch closes at 9.00 pm.', ['9 pm']), true);
  assert.equal(hasFact('The branch closes at 9 PM.', ['9 pm']), true);
  assert.equal(hasFact('It closes at 9:30 pm.', ['9 pm']), false);
  assert.equal(normalize('45 000 books'), '45000 books');
  assert.equal(normalize('45 000 books'), '45000 books');
  assert.equal(normalize('45.000 books'), '45000 books');
  assert.equal(normalize('45,000 books'), '45000 books');
  assert.equal(normalize('192.168.8.1'), '192.168.8.1');
  assert.equal(normalize('1.5 years'), '1.5 years');
  assert.equal(normalize('up to 5 days, 300 sar'), 'up to 5 days, 300 sar');
  assert.equal(hasFact('Hold it for twelve seconds', ['12 seconds']), true);
  assert.equal(hasFact('You get twenty-four working days', ['24 working days']), true);
  assert.equal(hasFact('You get 24 working days', ['twenty four working days']), true);
  assert.equal(hasFact('about three months', ['3 months']), true);
  assert.equal(hasFact('up to $40 per day', ['40 dollars']), true);
  assert.equal(hasFact('up to 1,200 US dollars', ['1200 us dollars']), true);
});

test('normalize: Arabic hours written as words, and refusals with curly quotes or bold', () => {
  const answer = 'من الساعة التاسعة صباحا حتى الساعة الثانية ظهرا';
  assert.equal(hasFact(answer, ['9 صباحا']), true);
  assert.equal(hasFact(answer, ['2 ظهرا']), true);
  assert.equal(hasFact('الدوام ثانية واحدة', ['2 ظهرا']), false);
  const sentence = "I couldn't find that in your uploaded documents.";
  assert.equal(isRefusal('I couldn’t find that in your uploaded documents.', sentence), true);
  assert.equal(isRefusal(`**${sentence}**`, sentence), true);
  assert.equal(isRefusal('`' + sentence + '`', sentence), true);
});

test('hasFact: a negated fact does not count', () => {
  assert.equal(hasFact('Employees get not 24 working days.', ['24 working days']), false);
  assert.equal(hasFact('It is not 24 days but 30.', ['24 days']), false);
  assert.equal(hasFact('Staff does not get 24 working days.', ['24 working days']), false);
  assert.equal(hasFact("Staff doesn't get 24 working days.", ['24 working days']), false);
  assert.equal(hasFact('ليس 24 يوما', ['24 يوما']), false);
  assert.equal(hasFact('No, they get 24 working days.', ['24 working days']), true);
  assert.equal(hasFact('There is no internet connection.', ['no internet']), true);
  assert.equal(hasFact('24 working days, not 18', ['24 working days']), true);
});

test('findCollisions: alternatives shared with a document that is not an expected source', () => {
  const docs = { 'hr.txt': 'Annual leave: 24 working days.', 'fleet.txt': 'Safety training takes 24 hours.', 'other.txt': 'Leave is 24 working days here too.' };
  const q = { sources: ['hr.txt'], facts: [['24 working days'], ['24 hours']] };
  assert.deepEqual(findCollisions(q, docs), [{ alternative: '24 working days', file: 'other.txt' }, { alternative: '24 hours', file: 'fleet.txt' }]);
  assert.deepEqual(findCollisions({ ...q, shared: { '24 working days': 'same policy text', '24 hours': 'also in the fleet handbook' } }, docs), []);
});

test('scoreQuestion: correctAndCited needs the expected source to be shown', () => {
  const run = { retrieved: [{ source: 'hr.txt', score: 0.6 }], answer: '24 working days.', sources: [{ source: 'fleet.txt' }] };
  const q = { id: 'q', sources: ['hr.txt'], facts: [['24 working days']] };
  const r = scoreQuestion(q, run, NOT_FOUND);
  assert.deepEqual([r.correct, r.citedAll, r.correctAndCited], [true, false, false]);
});

test('analyzeLogs keeps every line and names the models that failed', () => {
  const logs = [
    'LLM fallback: gemini-main failed (429 [GoogleGenerativeAI Error]: Error fetching), trying gemini-lite.',
    'LLM fallback model gemini-lite failed too (400 invalid).',
    'LLM error: ' + 'x'.repeat(400),
  ];
  const a = analyzeLogs(logs);
  assert.deepEqual(a.failedModels, ['gemini-main', 'gemini-lite']);
  assert.equal(a.mainFailed, true);
  assert.equal(a.fallbackUsed, false);
  assert.equal(a.logs.length, 3);
  assert.equal(a.logs[2].length, 300);
  const ok = analyzeLogs(['LLM fallback: m failed (503), trying f.', 'LLM answered with fallback model f.']);
  assert.deepEqual([ok.fallbackUsed, ok.failedModels], [true, ['m']]);
  assert.deepEqual(analyzeLogs([]), { logs: [], failedModels: [], mainFailed: false, fallbackUsed: false, answeredBy: null });
  assert.equal(analyzeLogs([], 'gemini-main').answeredBy, 'gemini-main');
  assert.equal(analyzeLogs(['LLM fallback: gemini-3.6-flash failed (429), trying gemini-3.5-flash-lite.', 'LLM answered with fallback model gemini-3.5-flash-lite.'], 'gemini-3.6-flash').answeredBy, 'gemini-3.5-flash-lite');
});

test('wilson: 95% interval', () => {
  const [lo, hi] = wilson(22, 25);
  assert.ok(Math.abs(lo - 0.7004) < 0.001 && Math.abs(hi - 0.9583) < 0.001, `${lo} ${hi}`);
  const [lo0, hi0] = wilson(0, 10);
  assert.equal(lo0, 0);
  assert.ok(Math.abs(hi0 - 0.2775) < 0.002, String(hi0));
  const [lo1, hi1] = wilson(10, 10);
  assert.equal(hi1, 1);
  assert.ok(Math.abs(lo1 - 0.7225) < 0.002, String(lo1));
  assert.equal(wilson(0, 0), null);
});

// ---- review round 2 (Rami's probes) ------------------------------------------------------------------
const questions = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'questions.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
const goldFor = (id) => questions.find((q) => q.id === id);
const passes = (id, answer) => scoreQuestion(goldFor(id), { retrieved: [], answer, sources: [] }, NOT_FOUND).correct;

test('natural correct answers still pass: short answers, :00 times, Arabic hour words without "الساعة"', () => {
  assert.equal(passes('en-10', 'Central.'), true);
  assert.equal(passes('en-10', 'Central (12 study rooms).'), true);
  assert.equal(passes('en-10', 'The Central branch has the most study rooms.'), true);
  assert.equal(passes('en-10', 'Harbor.'), false);
  assert.equal(passes('en-11', 'It closes at 21:00.'), true);
  assert.equal(passes('en-11', 'Lakeview closes at 9:00 PM.'), true);
  assert.equal(passes('en-11', 'Lakeview closes at 9 pm.'), true);
  assert.equal(passes('en-11', 'It closes at 20:00.'), false);
  assert.equal(passes('ar-05', 'من 9:00 صباحا إلى 2:00 ظهرا'), true);
  assert.equal(passes('ar-05', 'من التاسعة صباحا حتى الثانية ظهرا'), true);
  assert.equal(passes('ar-05', 'من الساعة التاسعة صباحا حتى الساعة الثانية ظهرا'), true);
  assert.equal(passes('ar-05', 'من التاسعة صباحا حتى الثالثة ظهرا'), false);
  assert.equal(normalize('10:00-21:00'), '10-21');
  assert.equal(normalize('1:10:00'), '1:10:00');
  assert.equal(normalize('9:00:30'), '9:00:30');
});

test('hasFact: a negator counts only next to the fact, in the same clause', () => {
  assert.equal(hasFact('There is no limit: 24 working days.', ['24 working days']), true);
  assert.equal(hasFact('Not many: 24 working days.', ['24 working days']), true);
  assert.equal(hasFact('No. 24 working days.', ['24 working days']), true);
  assert.equal(hasFact('You get 24 working days (not 18).', ['24 working days']), true);
  assert.equal(hasFact('It is not 24 days.', ['24 days']), false);
  assert.equal(hasFact('Not more than 24 working days.', ['24 working days']), false);
  assert.equal(hasFact('It is not less than 24 working days.', ['24 working days']), false);
  // Arabic negates the whole predicate that follows it, so a negator up to four words before counts.
  assert.equal(hasFact('لا يجب الإلغاء قبل 24 ساعة', ['24 ساعة']), false);
  assert.equal(hasFact('لا توجد رسوم إذا ألغيت الموعد قبل 24 ساعة.', ['24 ساعة']), true);
  assert.equal(hasFact('نعم، يجب الإلغاء قبل 24 ساعة.', ['24 ساعة']), true);
  assert.equal(hasFact('لا. يجب الإلغاء قبل 24 ساعة.', ['24 ساعة']), true);
});

test('hasFact: an Arabic negator after a conditional or exception word does not negate the fact (mirror of the Arabic negation probes)', () => {
  // natural correct answers for ar-02 (cancel at least 24 hours before)
  assert.equal(hasFact('تُحتسب رسوم إذا لم تلغ قبل 24 ساعة', ['24 ساعة']), true);
  assert.equal(hasFact('تُحتسب رسوم ما لم يتم الإلغاء قبل 24 ساعة', ['24 ساعة']), true);
  assert.equal(hasFact('لا يمكن الإلغاء إلا قبل 24 ساعة', ['24 ساعة']), true);
  assert.equal(hasFact('وإلا لم يعد الإلغاء ممكنا بعد 24 ساعة', ['24 ساعة']), true);
  assert.equal(hasFact('لو لم تلغ قبل 24 ساعة تُحتسب رسوم', ['24 ساعة']), true);
  assert.equal(hasFact('لا رسوم حتى 24 ساعة', ['24 ساعة']), true);
  // still negated without such a word
  assert.equal(hasFact('لا يجب الإلغاء قبل 24 ساعة', ['24 ساعة']), false);
  assert.equal(hasFact('لا تقبل الإلغاء قبل 24 ساعة', ['24 ساعة']), false);
  assert.equal(hasFact('ليس 24 يوما', ['24 يوما']), false);
  // a conditional word in an earlier clause does not rescue a negator in this one
  assert.equal(hasFact('إذا أردت الإلغاء، لا يجب الإلغاء قبل 24 ساعة', ['24 ساعة']), false);
});

test('scoreQuestion: the conditional answer from the review passes ar-02', () => {
  const q = goldFor('ar-02');
  assert.equal(scoreQuestion(q, { retrieved: [], answer: 'تُحتسب رسوم إذا لم تلغ قبل 24 ساعة', sources: [] }, NOT_FOUND).correct, true);
  assert.equal(scoreQuestion(q, { retrieved: [], answer: 'لا يجب الإلغاء قبل 24 ساعة', sources: [] }, NOT_FOUND).correct, false);
});

// ---- chunk-level retrieval: the gold facts are in a retrieved chunk of an expected source ----
const chunkTexts = {
  'hr.txt#1': 'Annual leave is 24 working days per year.',
  'hr.txt#2': 'The probation period is 90 days.',
  'other.txt#1': 'Annual leave is 24 working days per year (a look-alike document).',
};
const textOf = (source, chunk) => chunkTexts[`${source}#${chunk}`];
const leaveQuestion = { id: 'q', sources: ['hr.txt'], facts: [['24 working days', '24 days']] };

test('chunkHit: the retrieved chunk of the expected file holds the fact', () => {
  assert.equal(chunkHit(leaveQuestion, [{ source: 'hr.txt', chunk: 1 }], textOf), true);
});

test('chunkHit: the right file but the wrong chunk is a miss (the file-level hit would count it)', () => {
  const retrieved = [{ source: 'hr.txt', chunk: 2 }];
  assert.equal(chunkHit(leaveQuestion, retrieved, textOf), false);
  const record = scoreQuestion(leaveQuestion, { retrieved }, NOT_FOUND, textOf);
  assert.equal(record.retrievalAll, true);
  assert.equal(record.retrievalChunk, false);
});

test('chunkHit: a look-alike file holding the same words does not count, only expected sources do', () => {
  assert.equal(chunkHit(leaveQuestion, [{ source: 'other.txt', chunk: 1 }], textOf), false);
});

test('chunkHit: every fact needs a chunk; facts may be in different expected files', () => {
  const two = { id: 'm', sources: ['hr.txt', 'other.txt'], facts: [['90 days'], ['look-alike document']] };
  assert.equal(chunkHit(two, [{ source: 'hr.txt', chunk: 2 }], textOf), false);
  assert.equal(chunkHit(two, [{ source: 'hr.txt', chunk: 2 }, { source: 'other.txt', chunk: 1 }], textOf), true);
});

test('scoreQuestion: without a chunk-text lookup there is no chunk field; unanswerable questions never get one', () => {
  assert.equal('retrievalChunk' in scoreQuestion(leaveQuestion, { retrieved: [{ source: 'hr.txt', chunk: 1 }] }, NOT_FOUND), false);
  const none = { id: 'n', sources: [], facts: [] };
  assert.equal('retrievalChunk' in scoreQuestion(none, { retrieved: [] }, NOT_FOUND, textOf), false);
});

test('summarizeGroup: share of answerable questions with the right chunk (null when the run did not compute it)', () => {
  const records = [
    { answerable: true, retrievalChunk: true }, { answerable: true, retrievalChunk: false }, { answerable: true, retrievalChunk: true }, { answerable: false },
  ];
  assert.equal(summarizeGroup(records).retrievalChunk, 2 / 3);
  assert.equal(summarizeGroup([{ answerable: true, retrievalAll: true }]).retrievalChunk, null);
});
