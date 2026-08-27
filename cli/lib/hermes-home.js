/**
 * hermes-home.js — Resolve the Hermes home directory (#604).
 *
 * Resolution order:
 *   1. $HERMES_HOME when set — authoritative for Hermes itself on every
 *      platform (docs + source). Normalized with resolve() here so that this
 *      tier satisfies the same return contract as the other two (#611);
 *      it previously returned the environment value raw while tiers 2 and 3
 *      returned absolute paths, and every call site
 *      (cli/adapters/hermes.js:24,:27,:28 and cli/lib/detector.js:52) then
 *      wrapped the result in resolve() a second time.
 *
 *      What this fixes is the INCONSISTENCY, not the relativity. A relative
 *      $HERMES_HOME is still anchored to process.cwd() — now once, here,
 *      instead of once per call site — so two CLI invocations launched from
 *      different directories still see different Hermes homes. That is
 *      inherent to a relative path and is the user's choice to make; what
 *      is no longer possible is one function returning two different kinds
 *      of value depending on which tier answered.
 *   2. Windows-native default: %LOCALAPPDATA%\hermes, accepted only when its
 *      config.yaml exists. The marker check keeps an empty default directory
 *      (or a leftover from an uninstall) from claiming detection, and keeps
 *      the fallback reachable for a junction-style ~/.hermes setup.
 *   3. ~/.hermes — the Unix default, and the legitimate home when Hermes runs
 *      inside WSL on a Windows box (the repo already tracks WSL usage:
 *      #210, #415, #416). This path must keep working.
 *
 * The adapter previously hardcoded homedir()/.hermes in detect() and both
 * base paths, so a Windows-native install (home at %LOCALAPPDATA%\hermes)
 * was invisible to `detect` and required a manual directory junction before
 * anything fired.
 */
import { existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

/**
 * @returns {string} The Hermes home directory to detect against and install
 *   into, ALWAYS as an absolute path — every tier normalizes before returning,
 *   so no caller has to know which tier answered (#611).
 *
 *   $HERMES_HOME counts as unset when it is empty OR entirely whitespace. Both
 *   are quoting accidents rather than paths: a bare " " would otherwise become
 *   a directory literally named one space. The value that is USED is never
 *   trimmed, so a legitimate path with a leading or trailing space survives
 *   byte-for-byte — only the is-it-set test ignores whitespace.
 */
export function resolveHermesHome() {
  const fromEnv = process.env.HERMES_HOME;
  if (fromEnv && fromEnv.trim() !== '') return resolve(fromEnv);

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const winHome = resolve(localAppData, 'hermes');
      if (existsSync(resolve(winHome, 'config.yaml'))) return winHome;
    }
  }

  return resolve(homedir(), '.hermes');
}
