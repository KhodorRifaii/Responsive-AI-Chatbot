// Tests for the eval scorer (eval/score.js). It imports nothing from src/, so no .env, key or model is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, tokens, hasFact, isRefusal, isSoftRefusal, chanceHitAll, scoreQuestion, summarizeGroup } from '../eval/score.js';

test('normalize: digits, separators and Arabic spellings', () => {
  assert.equal(normalize('٢٢٬٠٠٠ ريال'), '22000 ريال');
  assert.equal(normalize('22,000 SAR'), '22000 sar');
  assert.equal(normalize('1,5 and 1.5'), '1,5 and 1.5');
  assert.equal(normalize('إِجَازَة'), 'اجازه');
  assert.equal(normalize('مدرسة'), normalize('مدرسه'));
});

test('tokens: attached letters and times split cleanly', () => {
  assert.deepEqual(tokens('ب30 يوما، 10:00-21:00'), ['ب', '30', 'يوما', '10', '00', '21', '00']);
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
