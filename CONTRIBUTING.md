# Contributing / Como contribuir

Thank you for helping people maintain their websites. Issues and pull requests may be written in English or Portuguese. Keep product interface strings in English.

Obrigado por ajudar quem mantém vários sites. Issues e pull requests podem ser escritos em inglês ou português. Mantenha os textos da interface em inglês.

1. Fork the repository and create a branch describing the change.
2. Follow the development steps in [README.md](README.md).
3. Reproduce the problem using controlled fixtures; do not rely on an external website being online.
4. Keep API, worker, and UI responsibilities separate. Never disable TLS or SSRF checks.
5. Run `npm run check` and relevant database/browser tests from [docs/TESTING.md](docs/TESTING.md).
6. Explain the behavior changed and how it was verified in your pull request. Include real screenshots for visible UI changes.

Do not commit credentials, customer domains, recipients, cookies, logs containing secrets, or `.env`. Use `.env.example` for configuration examples. Schema changes need a versioned migration; do not modify an already-deployed migration.

For a focused first contribution, improve documentation, accessibility, controlled error fixtures, or deployment examples. Discuss larger features in an issue before adding a new dependency or deployment service.
