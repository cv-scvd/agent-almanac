/**
 * hermes-home.js — Resolve the Hermes home directory (#604).
 *
 * Resolution order:
 *   1. $HERMES_HOME when set — authoritative for Hermes itself on every
 *      platform (docs + source).
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
 * @returns {string} The Hermes home directory to detect against and install into.
 */
export function resolveHermesHome() {
  const fromEnv = process.env.HERMES_HOME;
  if (fromEnv) return fromEnv;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const winHome = resolve(localAppData, 'hermes');
      if (existsSync(resolve(winHome, 'config.yaml'))) return winHome;
    }
  }

  return resolve(homedir(), '.hermes');
}
