# Contributing to ELSim

Thanks for contributing. Please open an issue before starting a large feature so its scope, compatibility, and license provenance can be agreed.

## Development

Use the shortest check that covers the change; don't run the full browser suite for every edit.

- Domain, netlist, schema, or migration change: `npm test`.
- UI-only change: run the relevant focused Firefox test, for example `npm run test:e2e:focus:firefox -- --grep "test title"`. If there is no focused test for the change, use `npm run test:e2e:ui`.
- Solver-backed workflow change: run the focused Firefox test with the local engine already built. The focused command reuses the running Vite server when available.
- Run `npm run typecheck` when changing TypeScript types or code shared across modules; run `npm run build` at a milestone or before a release check, not after every small change.
- Rebuild ngspice WASM only when changing ngspice C sources, Emscripten/build flags, or the worker-to-engine ABI. UI, lesson, plot, and TypeScript netlist changes use the existing local runtime.
- Do not run GitHub Actions or wait for a Pages build during normal feature work. Pages is a separate engine-free preview.

When changing persisted data or circuit behavior, update the relevant schema/migration and add a small reproducible example. Electrical changes should include a numeric check against the existing local ngspice runtime.

## Provenance and licensing

By submitting a contribution, you agree that it may be distributed under the repository's MIT License. Do not submit code, symbols, screenshots, fonts, examples, or models copied from LTspice, CircuitJS/Falstad, or another source unless the source and redistribution license are documented and compatible. Do not include manufacturer models unless redistribution rights are verified. Keep user-imported models local to the project and include their provenance and license status.

This project-level MIT license does not replace third-party notices or change the license of ngspice, dependencies, imported models, or other assets. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [ROADMAP.md](ROADMAP.md).
