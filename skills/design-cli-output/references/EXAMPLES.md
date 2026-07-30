# Design CLI Output — Extended Examples

Complete implementations for the patterns sketched in `SKILL.md`.

## Step 1: The no-color chalk fallback

### Why the short version fails

The idiom below is the one to recognize and reject. It is compact, it reads as
complete, and it is wrong:

```javascript
// broken.mjs — reproduces the defect. Run it: node broken.mjs
const chalk = new Proxy({}, { get: () => (s) => s });

console.log(chalk.dim('x'));         // 'x'       — direct styles are fine
console.log(chalk.hex('#FF6B35'));   // '#FF6B35' — a string, not a function
chalk.hex('#FF6B35')('flame');       // TypeError: chalk.hex(...) is not a function
```

Every property answers with `(s) => s`. That is right for a direct style, which
takes text and returns text, and wrong for a factory, which takes a color and
returns a styler. So `chalk.hex('#FF6B35')` yields the *string* `'#FF6B35'`, and
the call that immediately follows it throws.

Three properties separate a working stub from that one:

**1. A factory has to return a function.** Warm palettes are built almost
entirely from factories, and they are built at module load:

```javascript
const C = {
  flame: chalk.hex('#FF6B35'),
  amber: chalk.hex('#FFB347'),
};
```

Those lines run during `import`. A stub that returns strings there throws before
the program reaches `main()`, so the tool dies at startup in exactly the
situation the fallback existed to survive — chalk missing or unimportable, where
plain text was the whole point.

**2. The stub must not be a thenable.** A proxy that answers *every* property
with a function also answers `then` with a function. Any `await` on it — or any
`Promise.resolve()` that wraps it — then hangs forever, because the runtime calls
`.then(resolve, reject)` and waits for a callback that is never invoked:

```javascript
// hangs.mjs — do not expect this to exit.
const chalk = new Proxy((t) => t, { get: () => (t) => t });
await chalk;
// Node: "Detected unsettled top-level await", exit code 13
```

Returning `undefined` for `then` is what makes the object safe to `await`.

**3. `level` must be a number.** Chalk exposes `level` as an integer 0–3, and
capability checks read it numerically:

```javascript
function canRenderPixelArt() {
  return chalk.level >= 1;
}
```

A stub that returns a function for `level` makes that comparison `false` by
accident rather than by design (`function >= 1` is `NaN >= 1`), and any truthiness
check on `chalk.level` opens the gate with no color support behind it. `0` is the
truthful answer and keeps every such gate closed.

### The production stub, annotated

```javascript
/**
 * chalk-stub.js — the no-color fallback used when `import('chalk')` fails.
 *
 * Shared rather than duplicated. When two import sites each built their own
 * fallback, the identical bug existed twice, and a fix applied to one copy left
 * the other broken.
 */

/**
 * chalk members that return a *function* rather than a styled string.
 *
 * Enumerate this against the installed chalk rather than from memory: chalk 6
 * added the three `underline*` variants, and a list that omits them
 * reintroduces the string-instead-of-function bug for exactly those names.
 */
const CHALK_FACTORIES = new Set([
  'ansi256',
  'bgAnsi256',
  'bgHex',
  'bgRgb',
  'hex',
  'rgb',
  'underlineAnsi256',
  'underlineHex',
  'underlineRgb',
]);

/**
 * A chalk-shaped object that applies no color.
 *
 * Supports the three call shapes a palette uses:
 *   chalk.dim('x')            -> 'x'
 *   chalk.hex('#FF6B35')('x') -> 'x'
 *   chalk.bold.cyan('x')      -> 'x'
 *
 * @returns {any} a callable, chainable stub
 */
export function makeChalkStub() {
  const identity = (text) => text;
  return new Proxy(identity, {
    get(target, prop) {
      // Must not be a thenable, or `await chalk` never settles.
      if (prop === 'then') return undefined;
      // A stub means no color support, so 0 is the truthful answer and keeps
      // `level >= 1` capability gates closed.
      if (prop === 'level') return 0;
      // Symbols (Symbol.toPrimitive, util.inspect.custom, ...) should behave as
      // they would on a plain function rather than becoming more stubs.
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      // A factory must yield a function; a direct style must yield the string.
      if (CHALK_FACTORIES.has(prop)) return () => makeChalkStub();
      return makeChalkStub();
    },
  });
}
```

The proxy target is `identity`, not `{}`. A callable target is what lets the stub
be both indexed and invoked at every hop, which is what `chalk.bold.cyan('x')`
requires.

### Regenerating the factory list

Do not maintain the set by hand across a chalk major. Ask the installed copy
which of its members return a function:

```bash
node -e "import('chalk').then(m=>{const c=m.default;for(const n of
  Object.getOwnPropertyNames(Object.getPrototypeOf(c)))
  {if(n==='constructor')continue;
   try{if(typeof c[n]('#fff')==='function')console.log(n)}catch{}}})"
```

Run it after every chalk upgrade and diff the output against `CHALK_FACTORIES`.
Against chalk 6.0.0 it prints exactly the nine names above. The three
`underline*` ones appeared this way in the 6.0 major; a set written from memory
would have missed them.

The `constructor` skip is load-bearing. `Object.getPrototypeOf(chalk).constructor`
is `createChalk`, and `createChalk('#fff')` does return a function, so without the
skip the probe reports a tenth name that is not a factory. A probe with a known
false positive is still worth running — but paste its output through a diff, not
straight into the set.

### Runnable verification

The fallback is the one path a normal test run cannot reach: an `import` failure
cannot be provoked with an environment variable, and `NO_COLOR=1` exercises a
*working* chalk that declines to emit escapes. Assert on the stub directly.

```javascript
// verify-chalk-stub.mjs — node verify-chalk-stub.mjs
import assert from 'node:assert/strict';
import { makeChalkStub } from './chalk-stub.js';

const chalk = makeChalkStub();

// Direct styles pass text through.
assert.equal(chalk.dim('x'), 'x');
assert.equal(chalk.red('x'), 'x');

// Factories return a callable, not a string. This is the defect itself.
assert.equal(typeof chalk.hex('#FF6B35'), 'function');
assert.equal(chalk.hex('#FF6B35')('flame'), 'flame');
assert.equal(chalk.bgHex('#FFB347')('bg'), 'bg');
assert.equal(chalk.rgb(1, 2, 3)('x'), 'x');

// The factories a given chalk major added most recently are the ones a
// hand-written list omits.
assert.equal(chalk.underlineHex('#fff')('x'), 'x');
assert.equal(chalk.underlineRgb(1, 2, 3)('x'), 'x');
assert.equal(chalk.underlineAnsi256(42)('x'), 'x');

// Chains resolve at any depth.
assert.equal(chalk.bold.cyan('x'), 'x');
assert.equal(chalk.bold.underline.red('x'), 'x');

// Capability gates stay closed, numerically.
assert.equal(chalk.level, 0);
assert.equal(chalk.level >= 1, false);

// Awaiting the stub settles instead of hanging.
assert.equal(await Promise.resolve(chalk), chalk);

console.log('chalk stub OK');
```

A green CLI test suite is not a substitute for these assertions. Test runners
pipe stdout, which puts `chalk.level` at 0, so colored and uncolored output are
byte-identical — the suite passes with chalk entirely broken. If you need to
prove color works at all, set `FORCE_COLOR=3` and assert on an escape sequence.
