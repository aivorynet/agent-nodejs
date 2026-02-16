# AIVory Monitor Node.js Agent

Node.js agent using V8 Inspector Protocol for capturing exceptions and breakpoint data.

## Requirements

- Node.js 16+ (V8 Inspector Protocol)
- npm or yarn

## Installation

```bash
npm install @aivory/monitor
# or
yarn add @aivory/monitor
```

## Usage

### Option 1: Require Hook (Recommended)

```bash
# Set API key
export AIVORY_API_KEY=your_api_key

# Run with require hook
node -r @aivory/monitor app.js

# Or in package.json
{
  "scripts": {
    "start": "node -r @aivory/monitor app.js"
  }
}
```

### Option 2: Programmatic Initialization

```javascript
import { init } from '@aivory/monitor';
// or: const { init } = require('@aivory/monitor');

init({
  apiKey: process.env.AIVORY_API_KEY,
  environment: 'production'
});

// Your application code
```

### Option 3: Framework Middleware

**Express:**
```javascript
import express from 'express';
import { expressMiddleware } from '@aivory/monitor';

const app = express();
app.use(expressMiddleware({ apiKey: process.env.AIVORY_API_KEY }));
```

**Fastify:**
```javascript
import Fastify from 'fastify';
import { fastifyPlugin } from '@aivory/monitor';

const app = Fastify();
app.register(fastifyPlugin, { apiKey: process.env.AIVORY_API_KEY });
```

**NestJS:**
```typescript
import { Module } from '@nestjs/common';
import { AIVoryMonitorModule } from '@aivory/monitor/nestjs';

@Module({
  imports: [
    AIVoryMonitorModule.forRoot({
      apiKey: process.env.AIVORY_API_KEY
    })
  ]
})
export class AppModule {}
```

## Configuration

```typescript
init({
  // Required
  apiKey: string,

  // Optional
  backendUrl: string,           // default: 'wss://api.aivory.net'
  environment: string,          // default: process.env.NODE_ENV

  // Capture settings
  capture: {
    maxDepth: number,           // default: 3
    maxStringLength: number,    // default: 1000
    maxArrayLength: number,     // default: 100
  },

  // Filtering
  include: string[],            // glob patterns to include
  exclude: string[],            // default: ['node_modules/**']

  // Performance
  sampling: {
    rate: number,               // 0-1, default: 1 (all)
    maxPerMinute: number,       // rate limit
  },

  // Source maps
  sourceMaps: {
    enabled: boolean,           // default: true
    uploadMaps: boolean,        // upload to backend
  }
});
```

## Building from Source

```bash
cd agent-nodejs
npm install
npm run build
```

## How It Works

1. **V8 Inspector Protocol**: Uses Node's built-in debugger for breakpoint support
2. **Exception Handling**: Hooks `process.on('uncaughtException')` and `unhandledRejection`
3. **Async Context**: Uses `AsyncLocalStorage` to track request context
4. **Source Maps**: Automatically resolves TypeScript/Babel source maps

## TypeScript Support

Full TypeScript support with type definitions included.

## Local Development Testing

### Quick Test (with test-app.js)

```bash
cd monitor-agents/agent-nodejs
npm run build
node test-app.js
```

This connects to the local backend and triggers sample exceptions automatically.

### Interactive Test Server

Start a test HTTP server that you can hit to trigger exceptions on demand:

```bash
cd monitor-agents/agent-nodejs
node -e "
const monitor = require('./dist');

monitor.init({
  apiKey: 'ilscipio-dev-2024',
  backendUrl: 'ws://localhost:19999/ws/monitor/agent',
  environment: 'development',
  debug: true
});

const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/error') throw new Error('Test sync error');
  if (req.url === '/null') { const x = null; x.foo(); }
  if (req.url === '/async') {
    setTimeout(() => { throw new Error('Async error'); }, 100);
    res.end('Async error in 100ms'); return;
  }
  res.end('Endpoints: /error, /null, /async');
});

server.listen(3333, () => console.log('Test server: http://localhost:3333'));
"
```

**Test URLs:**
- http://localhost:3333/error - Throws synchronous Error
- http://localhost:3333/null - Throws TypeError (null pointer)
- http://localhost:3333/async - Throws async Error after 100ms

### Prerequisites for Local Testing

1. Backend running on `localhost:19999`
2. Dev token bypass enabled (uses `ilscipio-dev-2024`)
3. Org schema `org_test_20` exists in database

## Troubleshooting

**Breakpoints not working:**
- Ensure source maps are available
- Check file paths match between IDE and runtime

**High memory usage:**
- Reduce `capture.maxDepth`
- Exclude large objects from capture

**Source map issues:**
- Ensure `.map` files are deployed
- Check `sourceMaps.enabled` is true

**Agent not connecting:**
- Check backend is running: `curl http://localhost:19999/health`
- Check WebSocket endpoint: `ws://localhost:19999/ws/monitor/agent`
- Verify dev token is accepted in backend logs
