// Why the coverage report used to move when the code did not.
//
// `npm run test:coverage` runs `node --test --experimental-test-coverage`, which points
// NODE_V8_COVERAGE at a scratch directory, lets every test process write a V8 profile
// into it, and merges the lot when the run ends. Any process that inherits that
// variable joins the merge — including children a test spawns itself.
//
// That merge is not additive in the direction you would expect. V8 reports the
// functions it has compiled, so a profile from a booted server contributes route
// handlers that the in-process suite never compiled at all: they arrive as new
// entries with a zero count and enlarge the denominator. Whether they arrived was a
// race between the child flushing on exit and the runner reading the directory, so
// index.js and leadSources.js swung between 100% and 74% across runs of identical
// code, and `--test-concurrency=4` made the race easy to lose.
//
// The fix is one line in helpers.js — childEnv() blanks NODE_V8_COVERAGE — and it is
// only as good as its use at every spawn site. Hence this file: tests for the helper,
// and one that walks the suite looking for a child spawned without it.
//
// It has to *blank* the variable, not delete it, and that distinction was worth a
// second round of this bug. child_process refills NODE_V8_COVERAGE from the parent's
// process.env whenever the env you hand it lacks the key as an own property, so the
// first version of childEnv() — a `delete` — did nothing in the one situation it
// existed for. The proof is in the report: `BRDA:2513` and `BRDA:2514` (inside the
// `node:coverage disable` bootstrap block at the foot of index.js, which no in-process
// test can execute at all) turned up in one run's lcov and not the next.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { childEnv } from './helpers.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))

// What a child spawned with `env` reports for NODE_V8_COVERAGE. This file is the one
// place allowed to spawn without childEnv — proving the inheritance needs a child that
// *does* see the variable — which is why the guard below excludes it by name.
const sees = (env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['-p', 'process.env.NODE_V8_COVERAGE ?? "unset"'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c))
    child.on('exit', () => resolve(out.trim()))
  })

test('childEnv hands on the environment with the coverage directory turned off', () => {
  const env = childEnv({ HARNESS_MODE: 'boot' })

  // Empty, not absent — see the next test for why the difference is the whole fix.
  assert.equal(env.NODE_V8_COVERAGE, '')
  assert.equal(env.HARNESS_MODE, 'boot', 'the overrides a caller asked for must survive')
  assert.equal(env.PATH, process.env.PATH, 'the rest of the environment must be handed on intact')
})

test('childEnv keeps the key present, because deleting it lets child_process put it back', async () => {
  // The trap this whole file exists for. child_process copies NODE_V8_COVERAGE out of
  // the parent's process.env into the env you pass whenever that env lacks the key as
  // an own property — so `delete env.NODE_V8_COVERAGE`, the obvious spelling, is a
  // no-op at the point it matters. Assert the copy really happens rather than trusting
  // this comment: if a future Node drops the behaviour, this test says so instead of
  // silently guarding nothing.
  const deleted = { ...process.env, NODE_V8_COVERAGE: '/tmp/cov-probe' }
  delete deleted.NODE_V8_COVERAGE

  assert.equal(
    await sees(deleted),
    process.env.NODE_V8_COVERAGE ?? 'unset',
    'a deleted key is refilled from the parent, which is why childEnv blanks it instead',
  )
  assert.equal(childEnv({ NODE_V8_COVERAGE: '/tmp/somewhere' }).NODE_V8_COVERAGE, '')
})

test('a child really does inherit the coverage directory unless it is taken out', async () => {
  // The premise of the whole fix, asserted rather than assumed — and asserted in a way
  // that works whether or not this run is itself under --experimental-test-coverage,
  // by setting the variable here instead of relying on the runner having set it.
  assert.equal(
    await sees({ ...process.env, NODE_V8_COVERAGE: '/tmp/cov-probe' }),
    '/tmp/cov-probe',
    'a plain env spread hands the coverage directory to the child',
  )
  assert.equal(await sees(childEnv({ NODE_V8_COVERAGE: '/tmp/cov-probe' })), '')
})

test('a child given childEnv writes no profile into a coverage directory', async () => {
  // The assertions above are about a variable; this one is about the file that variable
  // causes, which is the thing that actually lands in the merge. Worth having both:
  // a Node that changed how the value is spelled but still profiled would slip past the
  // string comparisons and be caught here.
  const dir = mkdtempSync(path.join(tmpdir(), 'homenex-cov-'))
  try {
    const run = (env) =>
      new Promise((resolve) => {
        spawn(process.execPath, ['-e', 'void 0'], { env, stdio: 'ignore' }).on('exit', resolve)
      })

    await run(childEnv({ NODE_V8_COVERAGE: dir }))
    assert.deepEqual(readdirSync(dir), [], 'childEnv must leave the directory untouched')

    await run({ ...process.env, NODE_V8_COVERAGE: dir })
    assert.equal(readdirSync(dir).length, 1, 'without it the child drops a profile to merge')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every child this suite spawns is given childEnv', () => {
  // A spawn added without it would not fail anything — it would quietly put the report
  // back on the wrong side of a race, and the number would only look wrong to whoever
  // happened to run coverage twice. So the guard has to be a test.
  //
  // Deliberately textual: the alternative is parsing, and the shape being guarded is a
  // one-line habit at the call site rather than anything a type could carry.
  const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath/g
  const offenders = []

  // This file is excluded: its own spawn takes the environment as a parameter, because
  // proving the inheritance needs a child that *does* see the variable.
  const SELF = path.basename(fileURLToPath(import.meta.url))
  const files = [
    ...readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js') && f !== SELF),
    ...readdirSync(path.join(TEST_DIR, 'fixtures')).map((f) => path.join('fixtures', f)),
  ]

  for (const file of files) {
    const src = readFileSync(path.join(TEST_DIR, file), 'utf8')
    for (const m of src.matchAll(CALL)) {
      // The options object always follows the argv within a few lines. Read a generous
      // window rather than balancing braces — a false pass needs childEnv to appear in
      // an unrelated call right below, which is not a way anyone writes this.
      const window = src.slice(m.index, m.index + 600)
      if (!window.includes('childEnv')) {
        offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these spawn a node child with an inherited NODE_V8_COVERAGE, which makes the ` +
      `coverage report race:\n  ${offenders.join('\n  ')}\nPass env: childEnv({…}) instead.`,
  )
})

test('the guard above would notice a spawn that skipped childEnv', () => {
  // The guard is a regex over source text, so it is worth proving it can fail: a
  // pattern that matches nothing would pass this suite forever while guarding nothing.
  const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath/g
  const bad = `const child = spawn(process.execPath, [SCRIPT], { stdio: 'ignore' })`
  const good = `const child = spawn(process.execPath, [SCRIPT], { stdio: 'ignore', env: childEnv() })`

  assert.equal([...bad.matchAll(CALL)].length, 1, 'the call pattern no longer matches a spawn')
  assert.ok(!bad.slice(bad.match(CALL).index, 600).includes('childEnv'))
  assert.ok(good.slice(good.match(CALL).index, 600).includes('childEnv'))
})

test('test:coverage gates on the two metrics that hold still, and not on the third', () => {
  // Which metrics a threshold can be built on is a property of the tool, not a taste
  // question, and it is worth writing down where the next person will look.
  //
  // Lines and functions come out of the same numbers on every run. Branches do not:
  // V8 leaves out a nested range whose hit count matches its parent's, so the count of
  // branches *found* moves with how often code ran, not with what the code is. Under
  // --test-concurrency=4 that varies by itself. scheduler.js is the plain case —
  // between two runs of identical code its tally went 104/106 to 102/104: the same two
  // uncovered arms, two fewer branches in the denominator, because one range's count
  // came out equal to its parent's the second time and V8 stopped reporting it.
  //
  // So a branch threshold set anywhere near the real figure fails runs at random, and
  // one set low enough to be safe would not catch anything. Lines and functions do the
  // gating; branches stay a number to read.
  const pkg = JSON.parse(readFileSync(path.join(TEST_DIR, '../../package.json'), 'utf8'))
  const script = pkg.scripts['test:coverage']

  assert.match(script, /--test-coverage-lines=100\b/, 'lines are stable and complete — hold them there')
  assert.match(
    script,
    /--test-coverage-functions=100\b/,
    'functions are stable and complete too — the last uncovered one was the swallowed ' +
      'mark-failed in deliverDueFestiveSchedules, now driven by festive.test.js',
  )
  assert.doesNotMatch(
    script,
    /--test-coverage-branches=/,
    'a branch threshold cannot hold: read the comment above before adding one back',
  )
})
