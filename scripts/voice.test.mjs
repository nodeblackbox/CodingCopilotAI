// node --test scripts/voice.test.mjs — phrases taken from a real voice session (2026-10-02 run).
import test from 'node:test'
import assert from 'node:assert/strict'
import { localIntent, normalizeSpokenNumbers, wantsClearFile, wantsSolution } from '../src/shared/voiceIntents.ts'

test('normalizeSpokenNumbers: what speech-to-text writes for navigation', () => {
  assert.equal(normalizeSpokenNumbers('Perfect. Okay, go to line four.'), 'Perfect. Okay, go to line 4.')
  assert.equal(normalizeSpokenNumbers('Go to highlight from line five to line nine.'), 'Go to highlight from line 5 to line 9.')
  assert.equal(normalizeSpokenNumbers('go to line twenty two'), 'go to line 22')
  assert.equal(normalizeSpokenNumbers('go to line twenty-two'), 'go to line 22')
  assert.equal(normalizeSpokenNumbers('highlight lines three to seven'), 'highlight lines 3 to 7')
  assert.equal(normalizeSpokenNumbers('go to line for'), 'go to line 4')
  assert.equal(normalizeSpokenNumbers('go to line 12'), 'go to line 12')
  // "to" between numbers is a range word, not a 2
  assert.equal(normalizeSpokenNumbers('select line five to nine'), 'select line 5 to 9')
})

test('localIntent: quiet', () => {
  assert.equal(localIntent('Shut up.'), 'quiet')
  assert.equal(localIntent('okay stop talking'), 'quiet')
  assert.equal(localIntent('Bro, be quiet please'), 'quiet')
  assert.equal(localIntent('stop, go back to line 4'), null)
  assert.equal(localIntent('What the hell bruh you broke like I told you to shut up and you didn\'t shut up'), null)
})

test('localIntent: hold (thinking out loud, no answer needed)', () => {
  assert.equal(localIntent('Um'), 'hold')
  assert.equal(localIntent('Wait, wait, give me a second. Um'), 'hold')
  assert.equal(localIntent('Okay wait'), 'hold')
  assert.equal(localIntent('hold on'), 'hold')
  // real content or a question still goes to the model
  assert.equal(localIntent('Yes.'), null)
  assert.equal(localIntent('Okay.'), null)
  assert.equal(localIntent('Wait what?'), null)
  assert.equal(localIntent("Wait, I'm confused even more now."), null)
  assert.equal(localIntent('Yes, call it.'), null)
})

test('localIntent: run', () => {
  assert.equal(localIntent('Run it.'), 'run')
  assert.equal(localIntent('okay run the code'), 'run')
  assert.equal(localIntent('Now run it and see what prints.'), null)
})

test('wantsClearFile / wantsSolution', () => {
  assert.ok(wantsClearFile("Let's just remove everything uh currently in the uh you know"))
  assert.ok(wantsClearFile('clean slate'))
  assert.ok(!wantsClearFile('remove line 7 and line 8'))
  assert.ok(wantsSolution('ok I give up'))
  assert.ok(wantsSolution('just show me the answer'))
  assert.ok(!wantsSolution('Wait bro just return the function give me something to return the function'))
  assert.ok(!wantsSolution("don't give me the answer"))
})
