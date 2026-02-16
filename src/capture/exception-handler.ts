import { AgentConfig } from '../config';
import { BackendConnection } from '../transport/backend-connection';
import * as crypto from 'crypto';

export interface CapturedVariable {
  name: string;
  type: string;
  value: string;
  isNull: boolean;
  isTruncated: boolean;
  children?: Record<string, CapturedVariable>;
  arrayElements?: CapturedVariable[];
  arrayLength?: number;
}

export interface StackFrame {
  className?: string;
  methodName: string;
  fileName?: string;
  filePath?: string;
  lineNumber?: number;
  columnNumber?: number;
  isNative: boolean;
  sourceAvailable: boolean;
}

export interface ExceptionCapture {
  id: string;
  exceptionType: string;
  message: string;
  fingerprint: string;
  stackTrace: StackFrame[];
  localVariables: Record<string, CapturedVariable>;
  context: Record<string, unknown>;
  capturedAt: string;
}

// Forward declaration for InspectorManager to avoid circular dependency
interface InspectorManagerLike {
  getLastExceptionData(): { localVariables: Record<string, CapturedVariable> } | null;
  isExceptionPauseEnabled(): boolean;
  wasExceptionSentByInspector(exceptionType: string, stackTrace: StackFrame[]): boolean;
  getLocalsForError(error: Error): Promise<{ locals: Record<string, CapturedVariable>; stackTrace: StackFrame[] } | null>;
}

/**
 * Handles exception capture and reporting.
 */
export class ExceptionHandler {
  private config: AgentConfig;
  private connection: BackendConnection;
  private installed = false;
  private inspectorManager: InspectorManagerLike | null = null;

  private originalUncaughtException?: NodeJS.UncaughtExceptionListener;
  private originalUnhandledRejection?: NodeJS.UnhandledRejectionListener;

  constructor(config: AgentConfig, connection: BackendConnection) {
    this.config = config;
    this.connection = connection;
  }

  /**
   * Sets the inspector manager for capturing local variables.
   */
  setInspectorManager(inspector: InspectorManagerLike): void {
    this.inspectorManager = inspector;
  }

  /**
   * Installs the exception handlers.
   */
  install(): void {
    if (this.installed) {
      return;
    }

    // Capture uncaught exceptions
    this.originalUncaughtException = process.listeners('uncaughtException')[0] as NodeJS.UncaughtExceptionListener;
    process.on('uncaughtException', (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
      this.handleUncaughtException(error, origin);
      // Re-throw to maintain default behavior
      if (this.originalUncaughtException) {
        this.originalUncaughtException(error, origin);
      } else {
        // Default behavior: exit after brief delay to allow message send
        console.error('Uncaught exception:', error);
        setTimeout(() => process.exit(1), 500);
      }
    });

    // Capture unhandled promise rejections
    this.originalUnhandledRejection = process.listeners('unhandledRejection')[0] as NodeJS.UnhandledRejectionListener;
    process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
      this.handleUnhandledRejection(reason, promise);
      if (this.originalUnhandledRejection) {
        this.originalUnhandledRejection(reason, promise);
      }
    });

    this.installed = true;

    if (this.config.debug) {
      console.log('[AIVory Monitor] Exception handlers installed');
    }
  }

  /**
   * Uninstalls the exception handlers.
   */
  uninstall(): void {
    if (!this.installed) {
      return;
    }

    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');

    if (this.originalUncaughtException) {
      process.on('uncaughtException', this.originalUncaughtException);
    }

    if (this.originalUnhandledRejection) {
      process.on('unhandledRejection', this.originalUnhandledRejection);
    }

    this.installed = false;
  }

  /**
   * Manually capture an exception.
   * For caught exceptions, we look up cached local variables from the inspector.
   */
  async capture(error: Error, context?: Record<string, unknown>): Promise<void> {
    if (!this.config.shouldSample()) {
      return;
    }

    const capture = this.createCapture(error, context);

    // For caught exceptions, try to get cached locals from inspector
    if (this.inspectorManager) {
      const cachedData = await this.inspectorManager.getLocalsForError(error);
      if (cachedData) {
        capture.localVariables = cachedData.locals;
        if (this.config.debug) {
          console.log(`[AIVory Monitor] Using ${Object.keys(cachedData.locals).length} cached local variables for caught exception`);
        }
      }
    }

    this.connection.sendException(capture);
  }

  private async handleUncaughtException(error: Error, origin: NodeJS.UncaughtExceptionOrigin): Promise<void> {
    if (!this.config.shouldSample()) {
      return;
    }

    const capture = this.createCapture(error, { origin });

    // Try to get cached locals from inspector
    if (this.inspectorManager) {
      const cachedData = await this.inspectorManager.getLocalsForError(error);
      if (cachedData) {
        capture.localVariables = cachedData.locals;
        if (this.config.debug) {
          console.log(`[AIVory Monitor] Using ${Object.keys(cachedData.locals).length} cached local variables for uncaught exception`);
        }
      }
    }

    this.connection.sendException(capture);
  }

  private async handleUnhandledRejection(reason: unknown, promise: Promise<unknown>): Promise<void> {
    if (!this.config.shouldSample()) {
      return;
    }

    const error = reason instanceof Error ? reason : new Error(String(reason));
    const capture = this.createCapture(error, { type: 'unhandledRejection' });

    // Try to get cached locals from inspector
    if (this.inspectorManager) {
      const cachedData = await this.inspectorManager.getLocalsForError(error);
      if (cachedData) {
        capture.localVariables = cachedData.locals;
        if (this.config.debug) {
          console.log(`[AIVory Monitor] Using ${Object.keys(cachedData.locals).length} cached local variables for unhandled rejection`);
        }
      }
    }

    this.connection.sendException(capture);
  }

  private createCapture(error: Error, context?: Record<string, unknown>): ExceptionCapture {
    const stackTrace = this.parseStackTrace(error);
    const fingerprint = this.calculateFingerprint(error, stackTrace);

    // Try to get local variables from V8 Inspector if available
    let localVariables: Record<string, CapturedVariable> = {};
    if (this.inspectorManager && this.inspectorManager.isExceptionPauseEnabled()) {
      const inspectorData = this.inspectorManager.getLastExceptionData();
      if (inspectorData && inspectorData.localVariables) {
        localVariables = inspectorData.localVariables;
        if (this.config.debug) {
          console.log(`[AIVory Monitor] Using ${Object.keys(localVariables).length} local variables from V8 Inspector`);
        }
      }
    }

    return {
      id: crypto.randomUUID(),
      exceptionType: error.name || 'Error',
      message: error.message || '',
      fingerprint,
      stackTrace,
      localVariables,
      context: {
        ...this.config.getCustomContext(),
        ...context,
        user: this.config.getUser()
      },
      capturedAt: new Date().toISOString()
    };
  }

  private parseStackTrace(error: Error): StackFrame[] {
    const frames: StackFrame[] = [];
    const stack = error.stack || '';

    // Parse V8 stack trace format
    const lines = stack.split('\n').slice(1); // Skip "Error: message" line

    for (const line of lines) {
      const frame = this.parseStackFrame(line);
      if (frame) {
        frames.push(frame);
      }

      if (frames.length >= 50) {
        break;
      }
    }

    return frames;
  }

  private parseStackFrame(line: string): StackFrame | null {
    // Match various V8 stack formats:
    // "    at functionName (file:line:column)"
    // "    at file:line:column"
    // "    at async functionName (file:line:column)"

    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) {
      return null;
    }

    const content = trimmed.slice(3); // Remove "at "

    // Try to match "functionName (location)"
    const funcMatch = content.match(/^(?:async\s+)?(.+?)\s+\((.+)\)$/);
    if (funcMatch) {
      const methodName = funcMatch[1];
      const location = funcMatch[2];
      return this.parseLocation(methodName, location);
    }

    // Try to match just location
    const locationMatch = content.match(/^(.+):(\d+):(\d+)$/);
    if (locationMatch) {
      return {
        methodName: '<anonymous>',
        filePath: locationMatch[1],
        fileName: this.getFileName(locationMatch[1]),
        lineNumber: parseInt(locationMatch[2], 10),
        columnNumber: parseInt(locationMatch[3], 10),
        isNative: false,
        sourceAvailable: true
      };
    }

    // Native method
    if (content.includes('[native code]') || content === 'native') {
      return {
        methodName: content.replace(' [native code]', ''),
        isNative: true,
        sourceAvailable: false
      };
    }

    return {
      methodName: content,
      isNative: false,
      sourceAvailable: false
    };
  }

  private parseLocation(methodName: string, location: string): StackFrame {
    // Parse location like "file:line:column" or "native"
    if (location === 'native' || location.includes('[native code]')) {
      return {
        methodName,
        isNative: true,
        sourceAvailable: false
      };
    }

    const match = location.match(/^(.+):(\d+):(\d+)$/);
    if (match) {
      const filePath = match[1];
      return {
        methodName,
        filePath,
        fileName: this.getFileName(filePath),
        lineNumber: parseInt(match[2], 10),
        columnNumber: parseInt(match[3], 10),
        isNative: false,
        sourceAvailable: !filePath.includes('node_modules') && !filePath.startsWith('node:')
      };
    }

    return {
      methodName,
      filePath: location,
      isNative: false,
      sourceAvailable: false
    };
  }

  private getFileName(filePath: string): string {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  private calculateFingerprint(error: Error, stackTrace: StackFrame[]): string {
    const parts = [error.name || 'Error'];

    // Add first few non-native stack frames
    let added = 0;
    for (const frame of stackTrace) {
      if (added >= 5) break;
      if (frame.isNative) continue;

      parts.push(`${frame.methodName}:${frame.lineNumber || 0}`);
      added++;
    }

    const hash = crypto.createHash('sha256');
    hash.update(parts.join(':'));
    return hash.digest('hex').substring(0, 16);
  }
}
