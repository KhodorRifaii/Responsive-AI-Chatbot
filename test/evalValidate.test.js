// Tests for the question-file checks (eval/validate.js). Pure: no .env, key, model or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestions } from '../eval/validate.js';

const parsedText = {
  'clinic.txt': 'General check-up costs 150 riyals. Results arrive within 48 hours.',
  'solar.txt': 'Cleaning costs 150 riyals. Results of the survey take 48 hours.',
  'other.txt': 'Nothing relevant here.',
};
const docFiles = Object.keys(parsedText);
const base = { id: 'q1', lang: 'en', type: 'single', question: 'How much is a check-up at the clinic?', sources: ['clinic.txt'], facts: [['150 riyals']] };
const check = (q) => validateQuestions([{ ...base, ...q }], { docFiles, parsedText });

test('a good question has no problems; a collision without a reason is a warning', () => {
  const { problems, warnings } = check({});
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, ['q1: "150 riyals" also appears in solar.txt']);
});

test('a gold alternative that is already in the question text is a problem', () => {
  const { problems } = check({ question: 'The check-up costs 150 riyals, right?' });
  assert.match(problems.join(), /"150 riyals" is already in the question text/);
  // A topic word counts too, like the four Arabic facts that were free points.
  assert.match(check({ facts: [['150 riyals'], ['check-up']] }).problems.join(), /"check-up" is already in the question text/);
});

test('shared is { alternative: reason }: it silences the warning only with a reason, and only for a real collision', () => {
  const ok = check({ shared: { '150 riyals': 'the solar page has the same price' } });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.warnings, []);
  assert.match(check({ shared: { '150 riyals': '' } }).problems.join(), /needs a reason/);
  assert.match(check({ shared: ['150 riyals'] }).problems.join(), /must be an object/);
  assert.match(check({ facts: [['150 riyals'], ['within 48 hours']], shared: { 'within 48 hours': 'x' } }).problems.join(), /shared "within 48 hours" no longer appears/);
  assert.match(check({ shared: { '999 riyals': 'x' } }).problems.join(), /not one of the gold alternatives/);
  // clinic.txt is an expected source here, so a number that only appears in sources is not a collision any more.
  assert.match(check({ sources: ['clinic.txt', 'solar.txt'], type: 'multi', shared: { '150 riyals': 'x' } }).problems.join(), /no longer appears in another document/);
});
