/**
 * chalk-stub.js — the no-colour fallback used when `import('chalk')` fails.
 *
 * Both chalk import sites (reporter.js, tui.js) previously built their own
 * fallback as `new Proxy({}, { get: () => identity })`. That satisfies the direct
 * styles and breaks the factories: `chalk.hex('#FF6B35')` returned the *string*
 * `'#FF6B35'`, and calling it threw `TypeError: ... is not a function`. So the
 * "graceful degradation" path did not degrade — it crashed, and did so at module
 * load, because every palette here is built from `chalk.hex(...)` at import time
 * (campfire-reporter.js, tui.js, pixel-renderer.js). Filed as #455.
 *
 * Shared rather than duplicated: the identical bug existed twice, and a fix
 * applied to one copy would have left the other broken.
 */

/**
 * chalk members that return a *function* rather than a styled string.
 *
 * Enumerated empirically against the pinned chalk 6.0.0 rather than from memory —
 * chalk 6 added the three `underline*` variants, and a list that omits them
 * reintroduces the exact bug for those names. Regenerate with:
 *
 *   node -e "import('chalk').then(m=>{const c=m.default;for(const n of
 *     Object.getOwnPropertyNames(Object.getPrototypeOf(c)))
 *     {try{if(typeof c[n]('#fff')==='function')console.log(n)}catch{}}})"
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
 * A chalk-shaped object that applies no colour.
 *
 * Supports the three call shapes the CLI uses:
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
      // Must not be a thenable. A stub that answers every property with a
      // function makes `await chalk` (or any Promise.resolve(chalk)) hang
      // forever, because the runtime calls .then and waits for a callback that
      // is never invoked.
      if (prop === 'then') return undefined;
      // pixel-renderer.js reads chalk.level and gates on `>= 1`. A stub means no
      // colour support, so 0 is the truthful answer and keeps that gate closed.
      if (prop === 'level') return 0;
      // Symbols (Symbol.toPrimitive, util.inspect.custom, ...) should behave as
      // they would on a plain function, not become more stubs.
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      // A factory must yield a function; a direct style must yield the string.
      if (CHALK_FACTORIES.has(prop)) return () => makeChalkStub();
      return makeChalkStub();
    },
  });
}
