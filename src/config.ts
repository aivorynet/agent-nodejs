import * as os from 'os';
import * as crypto from 'crypto';

export interface GitContextConfig {
  /** Full release identifier, e.g. "myapp@1.2.3" or a commit SHA. Takes highest priority. */
  release?: string;
  /** Semantic version or tag, e.g. "1.2.3" */
  version?: string;
  /** Git commit SHA */
  commit?: string;
  /** Git branch name */
  branch?: string;
  /** Git remote URL (HTTPS or SSH) */
  repository?: string;
}

export interface ConfigOptions {
  apiKey?: string;
  backendUrl?: string;
  environment?: string;
  samplingRate?: number;
  maxCaptureDepth?: number;
  maxStringLength?: number;
  maxCollectionSize?: number;
  enableBreakpoints?: boolean;
  enableSourceMaps?: boolean;
  debug?: boolean;
  /**
   * Controls which JavaScript scopes are captured:
   * 0 = Local scope only (function arguments and local variables) - default, least verbose
   * 1 = Local + closure scopes (includes variables from parent functions)
   * 2 = All scopes including module/script level (most verbose)
   */
  scopeDepth?: number;
  /**
   * Git/release context for version tracking.
   * Can also be configured via environment variables (AIVORY_RELEASE, AIVORY_VERSION, etc.)
   * or platform-specific env vars (HEROKU_SLUG_COMMIT, GITHUB_SHA, etc.)
   */
  gitContext?: GitContextConfig;
}

export interface ResolvedGitContext {
  commit_hash: string;
  commit_short: string;
  branch: string;
  remote_url: string;
  version: string;
  project_name: string;
  project_identifier: string;
  source: string;
  captured_at: string;
}

export class AgentConfig {
  readonly apiKey: string;
  readonly backendUrl: string;
  readonly environment: string;
  readonly samplingRate: number;
  readonly maxCaptureDepth: number;
  readonly maxStringLength: number;
  readonly maxCollectionSize: number;
  readonly enableBreakpoints: boolean;
  readonly enableSourceMaps: boolean;
  readonly debug: boolean;
  readonly hostname: string;
  readonly agentId: string;
  readonly scopeDepth: number;

  /** Cached git context, built once at startup from config/env vars. Null if no info available. */
  readonly gitContext: ResolvedGitContext | null;

  private customContext: Record<string, unknown> = {};
  private user: { id?: string; email?: string; username?: string } = {};

  constructor(options: ConfigOptions) {
    this.apiKey = options.apiKey || process.env.AIVORY_API_KEY || '';
    this.backendUrl = options.backendUrl || process.env.AIVORY_BACKEND_URL || 'wss://api.aivory.net/ws/agent';
    console.log(`[AIVory Monitor] Backend URL: ${this.backendUrl}`);
    this.environment = options.environment || process.env.AIVORY_ENVIRONMENT || 'production';
    this.samplingRate = options.samplingRate ?? parseFloat(process.env.AIVORY_SAMPLING_RATE || '1.0');
    this.maxCaptureDepth = options.maxCaptureDepth ?? parseInt(process.env.AIVORY_MAX_DEPTH || '10', 10);
    this.maxStringLength = options.maxStringLength ?? parseInt(process.env.AIVORY_MAX_STRING_LENGTH || '1000', 10);
    this.maxCollectionSize = options.maxCollectionSize ?? parseInt(process.env.AIVORY_MAX_COLLECTION_SIZE || '100', 10);
    this.enableBreakpoints = options.enableBreakpoints ?? (process.env.AIVORY_ENABLE_BREAKPOINTS !== 'false');
    this.enableSourceMaps = options.enableSourceMaps ?? (process.env.AIVORY_ENABLE_SOURCEMAPS !== 'false');
    this.debug = options.debug ?? (process.env.AIVORY_DEBUG === 'true');
    this.scopeDepth = options.scopeDepth ?? parseInt(process.env.AIVORY_SCOPE_DEPTH || '0', 10);

    this.hostname = os.hostname();
    this.agentId = this.generateAgentId();

    // Build git context once at startup (cached for all exceptions)
    this.gitContext = this.resolveGitContext(options.gitContext);
    if (this.gitContext) {
      console.log(`[AIVory Monitor] Release context: version=${this.gitContext.version || 'N/A'}, commit=${this.gitContext.commit_short || 'N/A'}, branch=${this.gitContext.branch || 'N/A'}, project=${this.gitContext.project_identifier || 'N/A'}`);
    } else if (this.debug) {
      console.log('[AIVory Monitor] No release context available (set AIVORY_RELEASE or pass gitContext in init)');
    }
  }

  private generateAgentId(): string {
    const timestamp = Date.now().toString(16);
    const random = crypto.randomBytes(4).toString('hex');
    return `agent-${timestamp}-${random}`;
  }

  /**
   * Resolves git context using cascading priority:
   * 1. Explicit init config (options.gitContext)
   * 2. AIVORY_* environment variables
   * 3. Platform-specific environment variables (Heroku, Vercel, GitHub Actions, etc.)
   *
   * Returns null if no version/release information is available from any source.
   */
  private resolveGitContext(explicit?: GitContextConfig): ResolvedGitContext | null {
    // --- Layer 1: Explicit init config ---
    const release = explicit?.release || process.env.AIVORY_RELEASE || '';
    const version = explicit?.version || process.env.AIVORY_VERSION || '';
    const commit = explicit?.commit || process.env.AIVORY_COMMIT || '';
    const branch = explicit?.branch || process.env.AIVORY_BRANCH || '';
    const repository = explicit?.repository || process.env.AIVORY_REPOSITORY || '';

    // If AIVORY_RELEASE is set, parse it (supports "myapp@1.2.3" format)
    let parsedVersion = version;
    let parsedCommit = commit;
    if (release && !parsedVersion) {
      const atIndex = release.indexOf('@');
      if (atIndex > 0) {
        parsedVersion = release.substring(atIndex + 1);
      } else if (/^[0-9a-f]{7,40}$/i.test(release)) {
        // Looks like a commit SHA
        parsedCommit = parsedCommit || release;
      } else {
        parsedVersion = release;
      }
    }

    // --- Layer 2: Platform-specific auto-detection ---
    const env = process.env;

    // Commit SHA detection
    if (!parsedCommit) {
      parsedCommit =
        env.HEROKU_SLUG_COMMIT ||
        env.VERCEL_GIT_COMMIT_SHA ||
        env.CODEBUILD_RESOLVED_SOURCE_VERSION ||
        env.CIRCLE_SHA1 ||
        env.GITHUB_SHA ||
        env.CI_COMMIT_SHA ||
        env.GIT_COMMIT ||
        env.SOURCE_VERSION ||
        '';
    }

    // Branch detection
    let resolvedBranch = branch;
    if (!resolvedBranch) {
      resolvedBranch =
        env.VERCEL_GIT_COMMIT_REF ||
        env.CIRCLE_BRANCH ||
        env.GITHUB_REF_NAME ||
        env.CI_COMMIT_BRANCH ||
        env.CI_COMMIT_TAG ||
        '';
    }

    // Repository detection
    let resolvedRepo = repository;
    if (!resolvedRepo) {
      if (env.VERCEL_GIT_REPO_SLUG && env.VERCEL_GIT_REPO_OWNER) {
        resolvedRepo = `https://github.com/${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`;
      } else if (env.GITHUB_REPOSITORY) {
        resolvedRepo = `https://github.com/${env.GITHUB_REPOSITORY}`;
      } else if (env.CI_PROJECT_PATH) {
        resolvedRepo = `https://gitlab.com/${env.CI_PROJECT_PATH}`;
      } else if (env.CIRCLE_REPOSITORY_URL) {
        resolvedRepo = env.CIRCLE_REPOSITORY_URL;
      }
    }

    // Version detection
    if (!parsedVersion) {
      parsedVersion =
        env.HEROKU_RELEASE_VERSION ||
        env.APP_VERSION ||
        env.npm_package_version ||
        '';
    }

    // If we have nothing at all, return null
    if (!parsedVersion && !parsedCommit && !resolvedBranch && !resolvedRepo) {
      return null;
    }

    // Derive project identifier from repository URL
    let projectIdentifier = '';
    let projectName = '';
    if (resolvedRepo) {
      const match = resolvedRepo.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) {
        projectIdentifier = match[1];
        const parts = projectIdentifier.split('/');
        projectName = parts[parts.length - 1];
      }
    }

    // Build short commit hash
    const commitShort = parsedCommit ? parsedCommit.substring(0, 7) : '';

    return {
      commit_hash: parsedCommit,
      commit_short: commitShort,
      branch: resolvedBranch,
      remote_url: resolvedRepo,
      version: parsedVersion,
      project_name: projectName,
      project_identifier: projectIdentifier,
      source: 'agent',
      captured_at: new Date().toISOString()
    };
  }

  shouldSample(): boolean {
    if (this.samplingRate >= 1.0) return true;
    if (this.samplingRate <= 0.0) return false;
    return Math.random() < this.samplingRate;
  }

  setCustomContext(context: Record<string, unknown>): void {
    this.customContext = { ...context };
  }

  getCustomContext(): Record<string, unknown> {
    return { ...this.customContext };
  }

  setUser(user: { id?: string; email?: string; username?: string }): void {
    this.user = { ...user };
  }

  getUser(): { id?: string; email?: string; username?: string } {
    return { ...this.user };
  }

  getRuntimeInfo(): Record<string, string> {
    return {
      runtime: 'nodejs',
      runtimeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    };
  }
}
