# Contributing to AIVory Monitor Node.js Agent

Thank you for your interest in contributing to the AIVory Monitor Node.js Agent. Contributions of all kinds are welcome -- bug reports, feature requests, documentation improvements, and code changes.

## How to Contribute

- **Bug reports**: Open an issue at [GitHub Issues](https://github.com/aivorynet/agent-nodejs/issues) with a clear description, steps to reproduce, and your environment details (Node.js version, OS).
- **Feature requests**: Open an issue describing the use case and proposed behavior.
- **Pull requests**: See the Pull Request Process below.

## Development Setup

### Prerequisites

- Node.js 18 or later
- npm

### Build and Test

```bash
cd monitor-agents/agent-nodejs
npm install
npm run build
npm test
```

### Running the Agent

```bash
AIVORY_API_KEY=your-key node -r @aivory/monitor app.js
```

## Coding Standards

- Follow the existing code style in the repository.
- Write tests for all new features and bug fixes.
- Use TypeScript strict mode. Avoid `any` types where possible.
- Keep the V8 Inspector Protocol interactions well-documented.
- Ensure the agent does not interfere with the host application's event loop.

## Pull Request Process

1. Fork the repository and create a feature branch from `main`.
2. Make your changes and write tests.
3. Ensure all tests pass (`npm test`) and the build succeeds (`npm run build`).
4. Submit a pull request on [GitHub](https://github.com/aivorynet/agent-nodejs) or GitLab.
5. All pull requests require at least one review before merge.

## Reporting Bugs

Use [GitHub Issues](https://github.com/aivorynet/agent-nodejs/issues). Include:

- Node.js version and OS
- Agent version
- Error output or stack traces
- Minimal reproduction steps

## Security

Do not open public issues for security vulnerabilities. Report them to **security@aivory.net**. See [SECURITY.md](SECURITY.md) for details.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
