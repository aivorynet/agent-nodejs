import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { AgentConfig } from '../config';
import { ExceptionCapture } from '../capture/exception-handler';

interface Message {
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface BreakpointPayload {
  id: string;
  file_path: string;
  line_number: number;
  condition?: string;
}

export interface BackendConnectionEvents {
  'set_breakpoint': (payload: BreakpointPayload) => void;
  'remove_breakpoint': (payload: { id: string }) => void;
}

/**
 * WebSocket connection to the AIVory backend.
 */
export class BackendConnection extends EventEmitter {
  private config: AgentConfig;
  private ws: WebSocket | null = null;
  private connected = false;
  private authenticated = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private messageQueue: string[] = [];

  constructor(config: AgentConfig) {
    super();
    this.config = config;
  }

  /**
   * Connects to the backend.
   */
  connect(): void {
    if (this.connected) {
      return;
    }

    try {
      this.ws = new WebSocket(this.config.backendUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`
        }
      });

      this.ws.on('open', () => {
        if (this.config.debug) {
          console.log('[AIVory Monitor] WebSocket connected');
        }
        this.connected = true;
        this.reconnectAttempts = 0;
        this.authenticate();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        if (this.config.debug) {
          console.log(`[AIVory Monitor] WebSocket closed: ${code} - ${reason}`);
        }
        this.connected = false;
        this.authenticated = false;
        this.stopHeartbeat();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        if (this.config.debug) {
          console.error('[AIVory Monitor] WebSocket error:', error.message);
        }
      });

    } catch (error) {
      if (this.config.debug) {
        console.error('[AIVory Monitor] Failed to connect:', error);
      }
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnects from the backend.
   */
  disconnect(): void {
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.authenticated = false;
  }

  /**
   * Sends an exception capture to the backend.
   */
  sendException(capture: ExceptionCapture): void {
    const payload: Record<string, unknown> = {
      exception_type: capture.exceptionType,
      message: capture.message,
      fingerprint: capture.fingerprint,
      stack_trace: capture.stackTrace.map(frame => ({
        class_name: frame.className,
        method_name: frame.methodName,
        file_name: frame.fileName,
        file_path: frame.filePath,
        line_number: frame.lineNumber,
        column_number: frame.columnNumber,
        is_native: frame.isNative,
        source_available: frame.sourceAvailable
      })),
      local_variables: capture.localVariables,
      context: capture.context,
      captured_at: capture.capturedAt,
      agent_id: this.config.agentId,
      environment: this.config.environment,
      ...this.config.getRuntimeInfo()
    };

    // Attach cached git context (built at startup from env vars / init config)
    if (this.config.gitContext) {
      payload.git_context = this.config.gitContext;
    }

    this.send('exception', payload);
  }

  /**
   * Sends a breakpoint hit notification.
   */
  sendBreakpointHit(breakpointId: string, data: Record<string, unknown>): void {
    this.send('breakpoint_hit', {
      breakpoint_id: breakpointId,
      agent_id: this.config.agentId,
      ...data
    });
  }

  private send(type: string, payload: unknown): void {
    const message: Message = {
      type,
      payload,
      timestamp: Date.now()
    };

    const json = JSON.stringify(message);

    if (this.config.debug) {
      console.log(`[AIVory Monitor] Sending ${type}, ws=${!!this.ws}, readyState=${this.ws?.readyState}, auth=${this.authenticated}`);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
      this.ws.send(json);
      if (this.config.debug) {
        console.log(`[AIVory Monitor] Sent ${type} message`);
      }
    } else {
      // Queue message for later
      this.messageQueue.push(json);
      if (this.config.debug) {
        console.log(`[AIVory Monitor] Queued ${type} message (queue size: ${this.messageQueue.length})`);
      }

      // Limit queue size
      if (this.messageQueue.length > 100) {
        this.messageQueue.shift();
      }
    }
  }

  private authenticate(): void {
    const payload: Record<string, unknown> = {
      api_key: this.config.apiKey,
      agent_id: this.config.agentId,
      hostname: this.config.hostname,
      environment: this.config.environment,
      agent_version: '1.0.0',
      ...this.config.getRuntimeInfo()
    };

    // Include release context in registration so backend knows agent's version
    if (this.config.gitContext) {
      payload.git_context = this.config.gitContext;
    }

    const message: Message = {
      type: 'register',
      payload,
      timestamp: Date.now()
    };

    if (this.ws) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      const type = message.type;

      if (this.config.debug) {
        console.log(`[AIVory Monitor] Received: ${type}`);
      }

      switch (type) {
        case 'registered':
          this.handleRegistered();
          break;
        case 'error':
          this.handleError(message.payload);
          break;
        case 'set_breakpoint':
          this.handleSetBreakpoint(message.payload);
          break;
        case 'remove_breakpoint':
          this.handleRemoveBreakpoint(message.payload);
          break;
        default:
          if (this.config.debug) {
            console.log(`[AIVory Monitor] Unhandled message type: ${type}`);
          }
      }
    } catch (error) {
      if (this.config.debug) {
        console.error('[AIVory Monitor] Error parsing message:', error);
      }
    }
  }

  private handleRegistered(): void {
    this.authenticated = true;
    this.startHeartbeat();

    // Send queued messages
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (msg && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      }
    }

    if (this.config.debug) {
      console.log('[AIVory Monitor] Agent registered');
    }
  }

  private handleError(payload: { code?: string; message?: string }): void {
    console.error(`[AIVory Monitor] Backend error: ${payload.code} - ${payload.message}`);

    if (payload.code === 'auth_error' || payload.code === 'invalid_api_key') {
      console.error('[AIVory Monitor] Authentication failed, disabling reconnect');
      this.maxReconnectAttempts = 0;
      this.disconnect();
    }
  }

  private handleSetBreakpoint(payload: BreakpointPayload): void {
    // Emit event for InspectorManager to handle
    this.emit('set_breakpoint', payload);
  }

  private handleRemoveBreakpoint(payload: { id: string }): void {
    // Emit event for InspectorManager to handle
    this.emit('remove_breakpoint', payload);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.send('heartbeat', {
        timestamp: Date.now(),
        agent_id: this.config.agentId
      });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[AIVory Monitor] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);

    if (this.config.debug) {
      console.log(`[AIVory Monitor] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    }

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  isConnected(): boolean {
    return this.connected && this.authenticated;
  }
}
