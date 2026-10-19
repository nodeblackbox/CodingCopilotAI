// node --test scripts/   (Node 22.6+ strips TypeScript types natively, so the shared module is imported as-is.)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  inlineContextKind,
  inlineMaxTokens,
  limitInline,
  parseGhostCommand,
  partialWordBefore,
  resolvePartialWord
} from '../src/shared/inline.ts'

test('inlineContextKind: comments vs code', () => {
  assert.equal(inlineContextKind('x = 1\n# this loop is O(', 'python'), 'comment')
  assert.equal(inlineContextKind('x = 1  # because', 'python'), 'comment')
  assert.equal(inlineContextKind('int x = 1; // why', 'java'), 'comment')
  assert.equal(inlineContextKind('/* start\n still going', 'java'), 'comment')
  assert.equal(inlineContextKind('def f():\n    """doc', 'python'), 'comment')
  assert.equal(inlineContextKind('for i in range(', 'python'), 'code')
  assert.equal(inlineContextKind('s = "a # not a comment', 'python'), 'code')
})

test('limitInline: word', () => {
  assert.equal(limitInline('receive the package', 'word', 5), 'receive')
  assert.equal(limitInline(' function foo()', 'word', 5), ' function')
  assert.equal(limitInline('ion\nmore', 'word', 5), 'ion')
  assert.equal(limitInline('', 'word', 5), '')
})

test('limitInline: phrase caps words and stays on one line', () => {
  assert.equal(limitInline(' one two three four five six seven eight', 'phrase', 5), ' one two three four five six')
  assert.equal(limitInline('a b\nc d', 'phrase', 5), 'a b')
})

test('limitInline: line keeps a leading newline (next-line suggestion)', () => {
  assert.equal(limitInline('x = 1\ny = 2', 'line', 5), 'x = 1')
  assert.equal(limitInline('\nreturn x\nprint(x)', 'line', 5), '\nreturn x')
})

test('limitInline: lines honors the cap, block honors 25', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
  assert.equal(limitInline(ten, 'lines', 3), 'l0\nl1\nl2')
  assert.equal(limitInline(ten, 'block', 3).split('\n').length, 10)
  const forty = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
  assert.equal(limitInline(forty, 'block', 3).split('\n').length, 25)
  assert.equal(limitInline('a   \n', 'lines', 3), 'a')
})

test('partialWordBefore', () => {
  assert.equal(partialWordBefore('# we recie'), 'recie')
  assert.equal(partialWordBefore('# we recieved '), '')
  assert.equal(partialWordBefore('x = foo(bar'), 'bar')
  assert.equal(partialWordBefore('# it\'s'), "it's")
})

test('resolvePartialWord: remainder vs spelling replacement', () => {
  assert.deepEqual(resolvePartialWord('receive the', 'rece'), { insertText: 'ive the', replacePartial: false })
  assert.deepEqual(resolvePartialWord('Receive', 'rece'), { insertText: 'ive', replacePartial: false })
  assert.deepEqual(resolvePartialWord('receive the', 'recie'), { insertText: 'receive the', replacePartial: true })
  assert.deepEqual(resolvePartialWord('anything', ''), { insertText: 'anything', replacePartial: false })
})

test('inlineMaxTokens grows with scope and has generous floors', () => {
  assert.ok(inlineMaxTokens('word', 5) >= 96)
  assert.ok(inlineMaxTokens('lines', 15) > inlineMaxTokens('lines', 2))
  assert.ok(inlineMaxTokens('block', 5) >= inlineMaxTokens('line', 5))
})

test('parseGhostCommand: imperative commands only', () => {
  assert.deepEqual(parseGhostCommand('turn ghost text off')?.patch, { inlineCompletions: false })
  assert.deepEqual(parseGhostCommand('Turn ghost text on please')?.patch, { inlineCompletions: true })
  assert.equal(parseGhostCommand('ghost text one line only')?.patch.inlineScope, 'line')
  assert.equal(parseGhostCommand('set ghost text to words')?.patch.inlineScope, 'word')
  assert.equal(parseGhostCommand('make ghost text a few lines')?.patch.inlineScope, 'lines')
  assert.equal(parseGhostCommand('ghost text whole block')?.patch.inlineScope, 'block')
  assert.deepEqual(parseGhostCommand('ghost text comments only')?.patch, { inlineCompletions: true, inlineInCode: false, inlineInComments: true })
  assert.deepEqual(parseGhostCommand('ghost text code only')?.patch, { inlineCompletions: true, inlineInCode: true, inlineInComments: false })
})

test('parseGhostCommand: ordinary talk must not change settings', () => {
  assert.equal(parseGhostCommand('how does ghost text work?'), null)
  assert.equal(parseGhostCommand('I want to predict the next value, just use a loop'), null)
  assert.equal(parseGhostCommand('use a hash map and make the whole function faster'), null)
  assert.equal(parseGhostCommand('why is the ghost text so slow'), null)
  assert.equal(parseGhostCommand('the ghost text thing is great but the code needs a loop to turn the list into a map and then return'), null)
})

test('restoreFlattenedNewlines: only flattened line breaks, never real string escapes', async () => {
  const { restoreFlattenedNewlines } = await import('../src/shared/inline.ts')
  const BS = String.fromCharCode(92)
  assert.equal(restoreFlattenedNewlines(`if x:${BS}n        return 1`), 'if x:\n        return 1')
  assert.equal(restoreFlattenedNewlines(`print("a${BS}n")`), `print("a${BS}n")`)
  assert.equal(restoreFlattenedNewlines('already\nmultiline'), 'already\nmultiline')
})
