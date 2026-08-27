/**
 * base.js — Abstract base class for framework adapters.
 *
 * Every adapter must implement these methods. The base provides sensible
 * defaults where possible.
 */

/**
 * @typedef {Object} InstallResult
 * @property {string} action - 'created' | 'updated' | 'skipped'
 * @property {string} path - The path where content was installed
 * @property {string} [details] - Additional info
 */

/**
 * @typedef {Object} AuditEntry
 * @property {string} framework - Framework display name
 * @property {string[]} ok - OK messages
 * @property {string[]} warnings - Warning messages
 * @property {string[]} errors - Error messages
 * @property {boolean} [crashed] - True when audit() threw and produced no verdict.
 *   Set by auditAll(), not by adapters — see cli/lib/installer.js. Absent on
 *   entries obtained by calling an adapter's audit() directly.
 * @property {Error} [error] - The original throw, present only when crashed
 */

export class FrameworkAdapter {
  /** @type {string} Unique framework identifier */
  static id = 'base';

  /** @type {string} Human-readable name */
  static displayName = 'Base';

  /** @type {string} Installation strategy: 'symlink' | 'copy' | 'file-per-item' | 'append-to-file' */
  static strategy = 'symlink';

  /** @type {string[]} Supported content types */
  static contentTypes = ['skill'];

  /**
   * @type {Array<'project'|'workspace'|'global'>} Scopes this adapter can
   *   honour. Most adapters install to exactly ONE place regardless of what
   *   `--scope` asked for — some always global (a home directory), some always
   *   project (a file inside projectDir) — and before #607 they accepted the
   *   flag and ignored it in silence, so `--scope project -f hermes` reported a
   *   successful install at a global path and `--scope global -f cursor` wrote
   *   into the project.
   *
   *   This default is permissive so a third-party adapter that predates the
   *   field keeps working. Every adapter shipped here declares its own value
   *   instead of inheriting it, and `cli/test/cli.test.js` asserts that as an
   *   OWN property — so adding an adapter forces the decision rather than
   *   letting it default into silence.
   */
  static scopes = ['project', 'global'];

  /**
   * Check whether this framework is present in the project directory.
   * @param {string} projectDir
   * @returns {Promise<boolean>}
   */
  async detect(projectDir) {
    return false;
  }

  /**
   * Return the target directory for the given scope.
   * @param {string} projectDir
   * @param {'project'|'workspace'|'global'} scope
   * @returns {string}
   */
  getTargetPath(projectDir, scope) {
    throw new Error(`${this.constructor.id}: getTargetPath() not implemented`);
  }

  /**
   * Install a single content item.
   * @param {object} item - { type, id, sourcePath, sourceDir, ... }
   * @param {string} projectDir
   * @param {string} scope
   * @param {object} options - { dryRun, force, almanacRoot }
   * @returns {Promise<InstallResult>}
   */
  async install(item, projectDir, scope, options) {
    throw new Error(`${this.constructor.id}: install() not implemented`);
  }

  /**
   * Uninstall a single content item.
   * @param {object} item - { type, id }
   * @param {string} projectDir
   * @param {string} scope
   * @param {object} options - { dryRun }
   * @returns {Promise<InstallResult>}
   */
  async uninstall(item, projectDir, scope, options) {
    throw new Error(`${this.constructor.id}: uninstall() not implemented`);
  }

  /**
   * List installed items for this framework.
   * @param {string} projectDir
   * @param {string} scope
   * @returns {Promise<object[]>}
   */
  async listInstalled(projectDir, scope) {
    return [];
  }

  /**
   * Audit installed content for health issues.
   * @param {string} projectDir
   * @param {string} scope
   * @returns {Promise<AuditEntry>}
   */
  async audit(projectDir, scope) {
    return {
      framework: this.constructor.displayName,
      ok: [],
      warnings: [],
      errors: [],
    };
  }

  /**
   * Check if this adapter supports a content type.
   * @param {string} contentType - 'skill' | 'agent' | 'team'
   * @returns {boolean}
   */
  supports(contentType) {
    return this.constructor.contentTypes.includes(contentType);
  }

  /**
   * Check if this adapter can honour a requested install scope.
   * @param {string} scope - 'project' | 'workspace' | 'global'
   * @returns {boolean}
   */
  supportsScope(scope) {
    return this.constructor.scopes.includes(scope);
  }

  /**
   * The scope this adapter will ACTUALLY use for a requested one.
   *
   * Returns the request unchanged when the adapter can honour it. When it
   * cannot AND the adapter has exactly one scope, that scope is the answer —
   * it is where the install lands no matter what was asked for. With more
   * than one supported scope there is no single truthful answer, so this
   * returns null and the caller reports the mismatch without naming a
   * destination it cannot derive.
   *
   * @param {string} scope
   * @returns {string|null} The effective scope, or null when undeterminable.
   */
  effectiveScope(scope) {
    if (this.supportsScope(scope)) return scope;
    const { scopes } = this.constructor;
    return scopes.length === 1 ? scopes[0] : null;
  }
}
