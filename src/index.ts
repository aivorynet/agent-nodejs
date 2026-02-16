/**
 * AIVory Monitor Node.js Agent
 *
 * Usage:
 * ```javascript
 * // At the very beginning of your application
 * require('@aivory/monitor-agent-nodejs').init({
 *   apiKey: 'your-api-key',
 *   environment: 'production'
 * });
 * ```
 */

import { AgentConfig, ConfigOptions } from './config';
import { ExceptionHandler } from './capture/exception-handler';
import { InspectorManager } from './inspector/inspector-manager';
import { BackendConnection } from './transport/backend-connection';

let initialized = false;
let config: AgentConfig;
let connection: BackendConnection | null = null;
let exceptionHandler: ExceptionHandler | null = null;
let inspectorManager: InspectorManager | null = null;

/**
 * Initializes the AIVory Monitor agent.
 */
export function init(options: ConfigOptions): void {
  if (initialized) {
    console.warn('[AIVory Monitor] Agent already initialized');
    return;
  }

  config = new AgentConfig(options);

  if (!config.apiKey) {
    console.error('[AIVory Monitor] API key is required. Set AIVORY_API_KEY or pass apiKey in options.');
    return;
  }

  console.log(`[AIVory Monitor] Initializing agent v1.0.0`);
  console.log(`[AIVory Monitor] Environment: ${config.environment}`);

  // Initialize backend connection
  connection = new BackendConnection(config);

  // Initialize V8 inspector for local variable capture and breakpoints
  // V8 Inspector is always enabled to capture local variables on exceptions
  inspectorManager = new InspectorManager(config, connection);
  inspectorManager.enable();

  // Initialize exception handler with inspector reference
  exceptionHandler = new ExceptionHandler(config, connection);
  exceptionHandler.setInspectorManager(inspectorManager);
  exceptionHandler.install();

  // Connect to backend
  connection.connect();

  // Register cleanup (NOT on 'exit' - that's synchronous and kills pending I/O)
  process.on('beforeExit', () => {
    shutdown();
  });

  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  initialized = true;
  console.log('[AIVory Monitor] Agent initialized successfully');
}

/**
 * Manually capture an exception.
 */
export function captureException(error: Error, context?: Record<string, unknown>): void {
  if (!initialized || !exceptionHandler) {
    console.warn('[AIVory Monitor] Agent not initialized');
    return;
  }

  exceptionHandler.capture(error, context);
}

/**
 * Set a custom context that will be sent with all captures.
 */
export function setContext(context: Record<string, unknown>): void {
  if (!initialized || !config) {
    console.warn('[AIVory Monitor] Agent not initialized');
    return;
  }

  config.setCustomContext(context);
}

/**
 * Set the current user for context.
 */
export function setUser(user: { id?: string; email?: string; username?: string }): void {
  if (!initialized || !config) {
    console.warn('[AIVory Monitor] Agent not initialized');
    return;
  }

  config.setUser(user);
}

/**
 * Shuts down the agent.
 */
export function shutdown(): void {
  if (!initialized) {
    return;
  }

  console.log('[AIVory Monitor] Shutting down agent');

  if (exceptionHandler) {
    exceptionHandler.uninstall();
  }

  if (inspectorManager) {
    inspectorManager.disable();
  }

  if (connection) {
    connection.disconnect();
  }

  initialized = false;
}

/**
 * Check if the agent is initialized.
 */
export function isInitialized(): boolean {
  return initialized;
}

// Express middleware
export function expressErrorHandler() {
  return (err: Error, req: any, res: any, next: any) => {
    captureException(err, {
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
        query: req.query,
        body: req.body
      }
    });
    next(err);
  };
}

// Re-export types
export { ConfigOptions } from './config';
