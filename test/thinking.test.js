import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinkingConfigFor } from '../src/services/thinking.js';

const level = (model, requested) => thinkingConfigFor(model, { level: requested, budget: 0 });

test('Gemini 3 models that take every level get the requested level', () => {
  for (const model of ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview']) {
    for (const requested of ['minimal', 'low', 'medium', 'high']) {
      assert.deepEqual(level(model, requested), { thinkingLevel: requested }, `${model} ${requested}`);
    }
  }
});

test('models without "minimal" get the nearest level they accept (minimal becomes low)', () => {
  for (const model of ['gemini-3.8-flash', 'gemini-3.1-pro-preview']) {
    assert.deepEqual(level(model, 'minimal'), { thinkingLevel: 'low' }, model);
    for (const requested of ['low', 'medium', 'high']) {
      assert.deepEqual(level(model, requested), { thinkingLevel: requested }, `${model} ${requested}`);
    }
  }
});

test('"default" sends no thinking setting for Gemini 3 models', () => {
  assert.equal(level('gemini-3.5-flash-lite', null), undefined);
});

test('Gemini 3 models that are not verified get no thinking setting at all', () => {
  for (const model of ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-preview', 'gemini-flash-latest', 'gemini-4-argon', 'gemini-4-neon', 'some-future-model']) {
    assert.equal(level(model, 'minimal'), undefined, model);
  }
});

test('Gemini 2.5 models use the token budget, never the level', () => {
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
    assert.deepEqual(thinkingConfigFor(model, { level: 'minimal', budget: 0 }), { thinkingBudget: 0 });
    assert.deepEqual(thinkingConfigFor(model, { level: 'minimal', budget: 512 }), { thinkingBudget: 512 });
    assert.equal(thinkingConfigFor(model, { level: 'minimal', budget: null }), undefined);
  }
});

test('the old bug: a Gemini 3 model never receives thinkingBudget', () => {
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash']) {
    assert.equal(JSON.stringify(thinkingConfigFor(model, { level: 'minimal', budget: 0 }) ?? {}).includes('thinkingBudget'), false, model);
  }
});
