# Contributing to ELSim

Thanks for contributing. Please open an issue before starting a large feature so its scope, compatibility, and license provenance can be agreed.

## Development

1. Use the Node.js version supported by `package.json` and install with `npm ci`.
2. Run `npm run build` before opening a pull request.
3. Add or update the relevant project schema, migration, documentation, and example circuit when changing persisted data or circuit behavior.
4. Electrical changes need a reproducible reference circuit and numeric comparison against the pinned ngspice engine once the WASM gate is available.

## Provenance and licensing

By submitting a contribution, you agree that it may be distributed under the repository's MIT License. Do not submit code, symbols, screenshots, fonts, examples, or models copied from LTspice, CircuitJS/Falstad, or another source unless the source and redistribution license are documented and compatible. Do not include manufacturer models unless redistribution rights are verified. Keep user-imported models local to the project and include their provenance and license status.

This project-level MIT license does not replace third-party notices or change the license of ngspice, dependencies, imported models, or other assets. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [ROADMAP.md](ROADMAP.md).
