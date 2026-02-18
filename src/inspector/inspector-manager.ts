import * as inspector from 'inspector';
import * as crypto from 'crypto';
import { AgentConfig } from '../config';
import { BackendConnection } from '../transport/backend-connection';
import { CapturedVariable, StackFrame } from '../capture/exception-handler';

interface Breakpoint {
  id: string;
  backendId: string;
  scriptId?: string;
  lineNumber: number;
  columnNumber?: number;
  condition?: string;
}

interface CapturedExceptionData {
  stackTrace: StackFrame[];
  localVariables: Record<string, CapturedVariable>;
  capturedAt: string;
}

interface CachedLocals {
  locals: Record<string, CapturedVariable>;
  stackTrace: StackFrame[];
  timestamp: number;
}

interface PendingCapture {
  promise: Promise<void>;
  timestamp: number;
}

/**
 * Manages V8 Inspector for debugging capabilities.
 * Enables pause on exceptions to capture local variables.
 */
export class InspectorManager {
  private config: AgentConfig;
  private connection: BackendConnection;
  private session: inspector.Session | null = null;
  private enabled = false;
  private breakpoints = new Map<string, Breakpoint>();
  private scriptUrls = new Map<string, string>();

  // Store last captured exception data for ExceptionHandler to use
  private lastExceptionData: CapturedExceptionData | null = null;
  private exceptionPauseEnabled = false;

  // Track exceptions we've already sent from the inspector to avoid duplicates
  private sentExceptionFingerprints = new Set<string>();

  // Cache for local variables - keyed by error stack
  private localsCache = new Map<string, CachedLocals>();
  private pendingCaptures = new Map<string, PendingCapture>();
  private readonly cacheMaxAge = 5000; // 5 seconds

  // Rate limiting to prevent performance impact
  private rateLimitCount = 0;
  private rateLimitReset = Date.now();
  private readonly rateLimitMax = 50; // max 50 captures per second

  constructor(config: AgentConfig, connection: BackendConnection) {
    this.config = config;
    this.connection = connection;
  }

  /**
   * Enables the inspector session.
   */
  enable(): void {
    if (this.enabled) {
      return;
    }

    try {
      this.session = new inspector.Session();
      this.session.connect();

      // Enable debugger
      this.session.post('Debugger.enable', {}, (err) => {
        if (err) {
          if (this.config.debug) {
            console.error('[AIVory Monitor] Failed to enable debugger:', err);
          }
          return;
        }

        // Enable pause on ALL exceptions to capture local variables (like Sentry does)
        // This captures locals for both caught and uncaught exceptions
        this.session!.post('Debugger.setPauseOnExceptions', { state: 'all' }, (err2) => {
          if (err2) {
            if (this.config.debug) {
              console.error('[AIVory Monitor] Failed to set pause on exceptions:', err2);
            }
          } else {
            this.exceptionPauseEnabled = true;
            if (this.config.debug) {
              console.log('[AIVory Monitor] Pause on ALL exceptions enabled (for local variable capture)');
            }
          }
        });

        if (this.config.debug) {
          console.log('[AIVory Monitor] V8 Inspector enabled');
        }
      });

      // Listen for script parsing to track script URLs
      this.session.on('Debugger.scriptParsed', (event) => {
        if (event.params.url) {
          this.scriptUrls.set(event.params.scriptId, event.params.url);
        }
      });

      // Listen for breakpoint hits
      this.session.on('Debugger.paused', (event) => {
        this.handlePaused(event);
      });

      // Listen for breakpoint events from backend
      process.on('aivory:set_breakpoint' as any, (data: any) => {
        this.setBreakpoint(data.id, data.file_path, data.line_number, data.condition);
      });

      process.on('aivory:remove_breakpoint' as any, (data: any) => {
        this.removeBreakpoint(data.id);
      });

      this.enabled = true;

    } catch (error) {
      if (this.config.debug) {
        console.error('[AIVory Monitor] Failed to initialize inspector:', error);
      }
    }
  }

  /**
   * Disables the inspector session.
   */
  disable(): void {
    if (!this.enabled || !this.session) {
      return;
    }

    // Remove all breakpoints
    for (const [id] of this.breakpoints) {
      this.removeBreakpoint(id);
    }

    this.session.post('Debugger.disable');
    this.session.disconnect();
    this.session = null;
    this.enabled = false;

    if (this.config.debug) {
      console.log('[AIVory Monitor] V8 Inspector disabled');
    }
  }

  /**
   * Sets a breakpoint at the specified location.
   */
  setBreakpoint(backendId: string, filePath: string, lineNumber: number, condition?: string): void {
    if (!this.enabled || !this.session) {
      return;
    }

    // Convert to 0-indexed line number
    const line = lineNumber - 1;

    // Try to set breakpoint by URL
    this.session.post('Debugger.setBreakpointByUrl', {
      lineNumber: line,
      urlRegex: this.filePathToRegex(filePath),
      condition: condition || ''
    }, (err, result) => {
      if (err) {
        if (this.config.debug) {
          console.error(`[AIVory Monitor] Failed to set breakpoint: ${err.message}`);
        }
        return;
      }

      if (result && result.breakpointId) {
        const breakpoint: Breakpoint = {
          id: result.breakpointId,
          backendId,
          lineNumber: line,
          condition
        };

        this.breakpoints.set(backendId, breakpoint);

        if (this.config.debug) {
          console.log(`[AIVory Monitor] Breakpoint set: ${backendId} at ${filePath}:${lineNumber}`);
        }
      }
    });
  }

  /**
   * Removes a breakpoint.
   */
  removeBreakpoint(backendId: string): void {
    if (!this.enabled || !this.session) {
      return;
    }

    const breakpoint = this.breakpoints.get(backendId);
    if (!breakpoint) {
      return;
    }

    this.session.post('Debugger.removeBreakpoint', {
      breakpointId: breakpoint.id
    }, (err) => {
      if (err) {
        if (this.config.debug) {
          console.error(`[AIVory Monitor] Failed to remove breakpoint: ${err.message}`);
        }
        return;
      }

      this.breakpoints.delete(backendId);

      if (this.config.debug) {
        console.log(`[AIVory Monitor] Breakpoint removed: ${backendId}`);
      }
    });
  }

  private handlePaused(event: inspector.InspectorNotification<inspector.Debugger.PausedEventDataType>): void {
    if (!this.session) {
      return;
    }

    const { callFrames, hitBreakpoints, reason, data } = event.params;

    // Check if this is an exception pause
    if (reason === 'exception' || reason === 'promiseRejection') {
      // Rate limiting to prevent performance impact
      const now = Date.now();
      if (now > this.rateLimitReset) {
        this.rateLimitCount = 0;
        this.rateLimitReset = now + 1000;
      }
      if (++this.rateLimitCount > this.rateLimitMax) {
        if (this.config.debug) {
          console.log('[AIVory Monitor] Rate limit reached, skipping local variable capture');
        }
        this.session.post('Debugger.resume');
        return;
      }

      // Extract stack key from exception data for caching
      const stackKey = this.extractStackKey(data);

      if (this.config.debug) {
        console.log(`[AIVory Monitor] Exception paused, caching locals for: ${stackKey.substring(0, 50)}...`);
      }

      // IMPORTANT: Must capture BEFORE resuming - call frames become invalid after resume
      // Store pending capture promise so getLocalsForError can await it
      const capturePromise = this.captureAndCacheLocals(callFrames, stackKey, data);
      this.pendingCaptures.set(stackKey, {
        promise: capturePromise,
        timestamp: Date.now()
      });

      // Wait for capture to complete, then resume
      capturePromise.then(() => {
        // Remove from pending once complete
        this.pendingCaptures.delete(stackKey);

        // For uncaught exceptions, we also mark them as sent
        if (reason === 'exception') {
          const fingerprint = this.computeFingerprintFromCallFrames(callFrames, data);
          this.sentExceptionFingerprints.add(fingerprint);
          if (this.sentExceptionFingerprints.size > 100) {
            const first = this.sentExceptionFingerprints.values().next().value;
            if (first) this.sentExceptionFingerprints.delete(first);
          }
        }

        // Resume AFTER capture is complete
        this.session?.post('Debugger.resume');
      }).catch(() => {
        // Resume even on error
        this.session?.post('Debugger.resume');
      });

      return;
    }

    // Find which of our breakpoints was hit
    let hitBackendId: string | undefined;
    if (hitBreakpoints && hitBreakpoints.length > 0) {
      for (const [backendId, bp] of this.breakpoints) {
        if (hitBreakpoints.includes(bp.id)) {
          hitBackendId = backendId;
          break;
        }
      }
    }

    if (hitBackendId) {
      // Capture variables from call frames asynchronously
      this.captureCallFramesAsync(callFrames).then((capturedData) => {
        // Send to backend
        this.connection.sendBreakpointHit(hitBackendId!, {
          captured_at: new Date().toISOString(),
          ...capturedData
        });
        this.session?.post('Debugger.resume');
      }).catch(() => {
        this.session?.post('Debugger.resume');
      });
      return;
    }

    // Resume execution (non-breaking breakpoint)
    this.session.post('Debugger.resume');
  }

  /**
   * Extracts a cache key from exception data (the error.stack equivalent).
   * Uses the first 4 lines of the stack description.
   */
  private extractStackKey(exceptionData: any): string {
    if (exceptionData?.description) {
      const lines = (exceptionData.description as string).split('\n').slice(0, 4);
      return lines.join('|');
    }
    return `unknown-${Date.now()}`;
  }

  /**
   * Captures local variables and caches them for later lookup.
   */
  private async captureAndCacheLocals(
    callFrames: inspector.Debugger.CallFrame[],
    stackKey: string,
    exceptionData: any
  ): Promise<void> {
    try {
      const capturedData = await this.captureCallFramesAsync(callFrames);
      const localVariables = capturedData.local_variables as Record<string, CapturedVariable>;
      const stackTrace = capturedData.stack_trace as StackFrame[];

      // Cache the locals
      this.localsCache.set(stackKey, {
        locals: localVariables,
        stackTrace,
        timestamp: Date.now()
      });

      // Also store as lastExceptionData for backward compatibility
      this.lastExceptionData = {
        stackTrace,
        localVariables,
        capturedAt: new Date().toISOString()
      };

      // Cleanup old cache entries
      this.cleanupCache();

      if (this.config.debug) {
        console.log(`[AIVory Monitor] Cached ${Object.keys(localVariables).length} local variables`);
      }
    } catch (err) {
      if (this.config.debug) {
        console.error('[AIVory Monitor] Error caching locals:', err);
      }
    }
  }

  /**
   * Looks up cached local variables for an error.
   * Called by ExceptionHandler when captureException() is invoked.
   * This is async because it may need to wait for a pending capture to complete.
   */
  async getLocalsForError(error: Error): Promise<{ locals: Record<string, CapturedVariable>; stackTrace: StackFrame[] } | null> {
    if (!error.stack) return null;

    // Create stack key from error.stack (same format as extractStackKey)
    const lines = error.stack.split('\n').slice(0, 4);
    const stackKey = lines.join('|');

    // Check if there's a pending capture for this stack
    const pending = this.pendingCaptures.get(stackKey);
    if (pending) {
      if (this.config.debug) {
        console.log(`[AIVory Monitor] Waiting for pending capture to complete...`);
      }
      // Wait for the capture to complete (with timeout)
      try {
        await Promise.race([
          pending.promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
        ]);
      } catch (err) {
        // Timeout or error - proceed to check cache anyway
      }
    }

    const cached = this.localsCache.get(stackKey);
    if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
      // Remove from cache after use (one-time use)
      this.localsCache.delete(stackKey);

      if (this.config.debug) {
        console.log(`[AIVory Monitor] Found cached locals for error: ${Object.keys(cached.locals).length} variables`);
      }

      return {
        locals: cached.locals,
        stackTrace: cached.stackTrace
      };
    }

    return null;
  }

  /**
   * Cleans up old cache entries.
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.localsCache) {
      if (now - value.timestamp > this.cacheMaxAge) {
        this.localsCache.delete(key);
      }
    }

    // Also limit cache size
    if (this.localsCache.size > 100) {
      const oldest = this.localsCache.keys().next().value;
      if (oldest) this.localsCache.delete(oldest);
    }
  }

  /**
   * Computes a fingerprint from call frames synchronously (without capturing all variables).
   * Used to mark the exception before the async capture starts.
   * Uses exception type + line numbers only (file paths may not be available yet).
   */
  private computeFingerprintFromCallFrames(callFrames: inspector.Debugger.CallFrame[], exceptionData: any): string {
    let exceptionType = 'Error';

    if (exceptionData) {
      if (exceptionData.className) {
        exceptionType = exceptionData.className;
      } else if (exceptionData.description) {
        const desc = exceptionData.description as string;
        const colonIndex = desc.indexOf(':');
        if (colonIndex > 0) {
          exceptionType = desc.substring(0, colonIndex).trim();
        }
      }
    }

    // Use exception type + first 3 line numbers as fingerprint
    // This is simple but effective for deduplication within a short time window
    const lineNumbers: number[] = [];
    for (let i = 0; i < Math.min(3, callFrames.length); i++) {
      lineNumbers.push(callFrames[i].location.lineNumber + 1);
    }

    return `${exceptionType}|${lineNumbers.join('|')}`;
  }

  /**
   * Captures exception context and sends it directly to the backend.
   * This is called from the Debugger.paused event handler for exceptions.
   */
  private async captureAndSendException(callFrames: inspector.Debugger.CallFrame[], exceptionData: any, fingerprint: string): Promise<void> {
    const capturedData = await this.captureCallFramesAsync(callFrames);
    const localVariables = capturedData.local_variables as Record<string, CapturedVariable>;
    const stackTrace = capturedData.stack_trace as StackFrame[];

    // Extract exception info
    let exceptionType = 'Error';
    let message = 'Unknown error';

    if (exceptionData) {
      // The data field contains the exception value description
      if (exceptionData.description) {
        const desc = exceptionData.description as string;
        // Format is usually "ErrorType: message"
        const colonIndex = desc.indexOf(':');
        if (colonIndex > 0) {
          exceptionType = desc.substring(0, colonIndex).trim();
          message = desc.substring(colonIndex + 1).trim();
        } else {
          message = desc;
        }
      }
      if (exceptionData.className) {
        exceptionType = exceptionData.className;
      }
    }

    // Store for ExceptionHandler in case it needs additional context
    this.lastExceptionData = {
      stackTrace,
      localVariables,
      capturedAt: new Date().toISOString()
    };

    // Build and send the exception capture
    const capture = {
      id: crypto.randomUUID(),
      exceptionType,
      message,
      fingerprint,
      stackTrace,
      localVariables,
      context: {
        ...this.config.getCustomContext(),
        user: this.config.getUser(),
        capturedBy: 'v8-inspector'
      },
      capturedAt: new Date().toISOString()
    };

    this.connection.sendException(capture);

    if (this.config.debug) {
      const varCount = Object.keys(localVariables).length;
      console.log(`[AIVory Monitor] Inspector captured and sent exception: ${exceptionType} with ${varCount} local variables`);
    }
  }

  /**
   * Checks if an exception with the given fingerprint was already sent by the inspector.
   * Uses exception type + line numbers only to match computeFingerprintFromCallFrames.
   */
  wasExceptionSentByInspector(exceptionType: string, stackTrace: StackFrame[]): boolean {
    // Use exception type + first 3 line numbers (same as computeFingerprintFromCallFrames)
    const lineNumbers: number[] = [];
    for (let i = 0; i < Math.min(3, stackTrace.length); i++) {
      lineNumbers.push(stackTrace[i].lineNumber || 0);
    }
    const fingerprint = `${exceptionType}|${lineNumbers.join('|')}`;
    return this.sentExceptionFingerprints.has(fingerprint);
  }

  /**
   * Gets the last captured exception data (local variables).
   * Returns null if no exception has been captured or data has been consumed.
   */
  getLastExceptionData(): CapturedExceptionData | null {
    const data = this.lastExceptionData;
    // Clear after retrieval to avoid stale data
    this.lastExceptionData = null;
    return data;
  }

  /**
   * Checks if exception pause is enabled.
   */
  isExceptionPauseEnabled(): boolean {
    return this.exceptionPauseEnabled;
  }

  /**
   * Async version that captures actual variable values using Runtime.getProperties.
   */
  private async captureCallFramesAsync(callFrames: inspector.Debugger.CallFrame[]): Promise<Record<string, unknown>> {
    const stackTrace: unknown[] = [];
    const localVariables: Record<string, CapturedVariable> = {};

    for (let i = 0; i < Math.min(callFrames.length, 50); i++) {
      const frame = callFrames[i];
      const scriptUrl = this.scriptUrls.get(frame.location.scriptId) || '';

      stackTrace.push({
        method_name: frame.functionName || '<anonymous>',
        file_path: scriptUrl,
        file_name: this.getFileName(scriptUrl),
        line_number: frame.location.lineNumber + 1,
        column_number: frame.location.columnNumber,
        is_native: scriptUrl.startsWith('native '),
        source_available: !scriptUrl.includes('node_modules') && !scriptUrl.startsWith('node:')
      });

      // Capture scope variables from first few frames
      // scopeDepth controls which scopes to capture:
      // 0 = local only, 1 = local + closure, 2 = all (except global built-ins)
      if (i < this.config.maxCaptureDepth) {
        const framePrefix = i === 0 ? '' : `frame${i}.`;
        for (const scope of frame.scopeChain) {
          const shouldCapture = this.shouldCaptureScope(scope.type);
          if (shouldCapture) {
            try {
              const scopeVars = await this.getObjectProperties(scope.object.objectId!, 0);
              for (const [name, value] of Object.entries(scopeVars)) {
                // Skip common global built-ins that add noise
                if (this.isGlobalBuiltin(name)) {
                  continue;
                }
                localVariables[framePrefix + name] = value;
              }
            } catch (err) {
              if (this.config.debug) {
                console.error('[AIVory Monitor] Failed to capture scope:', err);
              }
            }
          }
        }
      }
    }

    return {
      stack_trace: stackTrace,
      local_variables: localVariables
    };
  }

  /**
   * Gets properties of a remote object using Runtime.getProperties.
   */
  private getObjectProperties(objectId: string, depth: number): Promise<Record<string, CapturedVariable>> {
    return new Promise((resolve) => {
      if (!this.session || depth >= this.config.maxCaptureDepth) {
        resolve({});
        return;
      }

      this.session.post('Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: true
      }, async (err, result) => {
        if (err || !result) {
          resolve({});
          return;
        }

        const properties: Record<string, CapturedVariable> = {};

        for (const prop of result.result) {
          // Skip internal properties
          if (prop.name.startsWith('__') || prop.name === 'constructor') {
            continue;
          }

          const captured = await this.capturePropertyValue(prop, depth);
          if (captured) {
            properties[prop.name] = captured;
          }
        }

        resolve(properties);
      });
    });
  }

  /**
   * Captures a single property value, handling different types.
   */
  private async capturePropertyValue(prop: inspector.Runtime.PropertyDescriptor, depth: number): Promise<CapturedVariable | null> {
    const value = prop.value;
    if (!value) {
      return null;
    }

    const captured: CapturedVariable = {
      name: prop.name,
      type: value.type,
      value: '',
      isNull: false,
      isTruncated: false
    };

    switch (value.type) {
      case 'undefined':
        captured.type = 'undefined';
        captured.value = 'undefined';
        break;

      case 'boolean':
      case 'number':
        captured.value = String(value.value);
        break;

      case 'string': {
        const strValue = value.value as string;
        if (strValue.length > 500) {
          captured.value = strValue.substring(0, 500);
          captured.isTruncated = true;
        } else {
          captured.value = strValue;
        }
        break;
      }

      case 'symbol':
        captured.value = value.description || 'Symbol';
        break;

      case 'function':
        captured.type = 'function';
        captured.value = value.description || '[Function]';
        break;

      case 'object':
        if (value.subtype === 'null') {
          captured.type = 'null';
          captured.value = 'null';
          captured.isNull = true;
        } else if (value.subtype === 'array') {
          captured.type = 'array';
          // Get array length from description (e.g., "Array(5)")
          const match = value.description?.match(/Array\((\d+)\)/);
          captured.arrayLength = match ? parseInt(match[1], 10) : 0;
          captured.value = value.description || '[]';

          // Capture array elements if not too deep
          if (depth < this.config.maxCaptureDepth - 1 && value.objectId && captured.arrayLength <= 100) {
            const elements = await this.getArrayElements(value.objectId, depth + 1);
            if (elements.length > 0) {
              captured.arrayElements = elements;
            }
          }
        } else if (value.subtype === 'error') {
          captured.type = 'error';
          captured.value = value.description || '[Error]';
        } else if (value.subtype === 'date') {
          captured.type = 'date';
          captured.value = value.description || '[Date]';
        } else if (value.subtype === 'regexp') {
          captured.type = 'regexp';
          captured.value = value.description || '[RegExp]';
        } else if (value.subtype === 'map') {
          captured.type = 'map';
          captured.value = value.description || '[Map]';
        } else if (value.subtype === 'set') {
          captured.type = 'set';
          captured.value = value.description || '[Set]';
        } else {
          // Regular object
          captured.type = value.className || 'object';
          captured.value = value.description || '{}';

          // Capture object properties if not too deep
          if (depth < this.config.maxCaptureDepth - 1 && value.objectId) {
            const children = await this.getObjectProperties(value.objectId, depth + 1);
            if (Object.keys(children).length > 0) {
              captured.children = children;
            }
          }
        }
        break;

      case 'bigint':
        captured.type = 'bigint';
        captured.value = value.description || value.unserializableValue || '0n';
        break;

      default:
        captured.value = value.description || String(value.value);
    }

    return captured;
  }

  /**
   * Gets array elements as CapturedVariable array.
   */
  private async getArrayElements(objectId: string, depth: number): Promise<CapturedVariable[]> {
    return new Promise((resolve) => {
      if (!this.session) {
        resolve([]);
        return;
      }

      this.session.post('Runtime.getProperties', {
        objectId,
        ownProperties: true
      }, async (err, result) => {
        if (err || !result) {
          resolve([]);
          return;
        }

        const elements: CapturedVariable[] = [];

        for (const prop of result.result) {
          // Array indices are numeric strings
          if (/^\d+$/.test(prop.name)) {
            const captured = await this.capturePropertyValue(prop, depth);
            if (captured) {
              elements.push(captured);
            }
          }
        }

        resolve(elements);
      });
    });
  }

  /**
   * Determines if a scope type should be captured based on scopeDepth config.
   * Scope types: 'global', 'local', 'with', 'closure', 'catch', 'block', 'script', 'eval', 'module'
   */
  private shouldCaptureScope(scopeType: string): boolean {
    const depth = this.config.scopeDepth;

    // scopeDepth 0: local scope only (local, catch, block - immediate context)
    if (depth === 0) {
      return scopeType === 'local' || scopeType === 'catch' || scopeType === 'block';
    }

    // scopeDepth 1: local + closure scopes
    if (depth === 1) {
      return scopeType === 'local' || scopeType === 'catch' || scopeType === 'block' || scopeType === 'closure';
    }

    // scopeDepth 2+: all scopes except global (too noisy)
    return scopeType !== 'global';
  }

  /**
   * Checks if a variable name is a common Node.js global that adds noise.
   */
  private isGlobalBuiltin(name: string): boolean {
    const globalBuiltins = new Set([
      // Node.js globals
      'process', 'console', 'global', 'globalThis',
      'module', 'exports', 'require', '__filename', '__dirname',
      'Buffer', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      'queueMicrotask', 'performance', 'fetch',
      // Common module-level noise
      'arguments', 'this'
    ]);
    return globalBuiltins.has(name);
  }

  private filePathToRegex(filePath: string): string {
    // Escape special regex characters and create a pattern
    const escaped = filePath
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\//g, '[\\\\/]'); // Handle both forward and back slashes

    return `.*${escaped}$`;
  }

  private getFileName(url: string): string {
    const parts = url.split(/[/\\]/);
    return parts[parts.length - 1];
  }
}
