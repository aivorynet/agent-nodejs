# Changelog

All notable changes to the AIVory Monitor Node.js Agent will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-02-16

### Added
- V8 Inspector Protocol integration for breakpoint support
- Automatic capture of uncaught exceptions and unhandled rejections
- AsyncLocalStorage-based request context tracking
- Source map resolution for TypeScript and transpiled code
- WebSocket connection to AIVory backend with automatic reconnection
- Configurable sampling rate, capture depth, and rate limiting
- Require hook for zero-code initialization (`node -r @aivory/monitor`)
- Express, Fastify, and NestJS middleware/plugin integrations
- Full TypeScript type definitions included
- Heartbeat and metrics reporting
