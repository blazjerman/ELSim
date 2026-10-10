# Third-party notices

ELSim source is distributed under the MIT License in [LICENSE](LICENSE). Third-party software keeps its own terms. The complete locked npm dependency inventory is in [`licenses/npm-dependencies.json`](licenses/npm-dependencies.json). This file includes the full declared license text for direct production dependencies bundled by the current browser build.

## lucide-react@0.468.0 — ISC

Source: https://github.com/lucide-icons/lucide

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## react-dom@19.1.0 — MIT

Source: https://github.com/facebook/react

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## react@19.1.0 — MIT

Source: https://github.com/facebook/react

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## scheduler@0.26.0 — MIT

Source: https://github.com/facebook/react

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ngspice WebAssembly runtime — redistribution review incomplete

The reproducible build script writes ngspice files into the Git-ignored `public/engine/` directory. Vite copies those files into `dist/engine/`, so a production build made after the engine has been generated **does contain and distribute** the WASM runtime and JavaScript loader. The build script also copies the pinned source tree's `COPYING` file, this notice, a build-info record, an Emscripten link map, and SHA-256 checksums beside the runtime. The link map provides linked-input evidence for review against per-directory source licenses; it does not classify licenses automatically. These files are provenance and notices; they do not by themselves satisfy every binary-distribution obligation.

ELSim pins ngspice commit `a80f6e3e95d51534905b1f23410a951802666656` from the [ngspice source repository](https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/) and relies on its upstream [`COPYING` inventory](https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/COPYING). The upstream inventory and manual state that most ngspice source is under a modified 3-clause BSD license, while `src/frontend/numparam` is LGPL-2.0-or-later, `src/xspice/icm/table` is GPL-2.0-or-later, and other sections carry separate terms including public-domain code. The build uses static linking, enables XSPICE, and does not explicitly disable `numparam`; it also removes the optional Verilog and VHDL subdirectories. **The exact object and code-model composition of the generated WASM has not been audited.** In particular, whether the GPL table model is linked into the delivered runtime is unresolved.

Do not publish a production bundle containing this runtime until the exact compiled source/object set has been inventoried, the LGPL and any other applicable terms have been satisfied (including source and relinking materials where required), the relevant notices are shipped, and a qualified reviewer has checked the distribution. ELSim's MIT license applies only to ELSim-authored source; it does not relicense ngspice or settle the compatibility of this combined distribution. See [`engine/wasm/README.md`](engine/wasm/README.md) and the M0.2 gate in [`ROADMAP.md`](ROADMAP.md).

`npm run build:release` is the repository's release build entry point. It fails closed unless `licenses/ngspice-distribution-review.json` records a qualified review for the exact generated JavaScript, WASM, upstream COPYING, and linker map hashes. The checked-in [`review template`](licenses/ngspice-distribution-review.template.json) is intentionally not approval. Ordinary `npm run build` remains intended for local development and can copy any locally generated, ignored `public/engine/` runtime into `dist/`; do not publish such a bundle without a passing release check. The checker enforces presence and hash binding of review claims; it does not validate the legal conclusions in those claims.

## User-provided models

Imported models are not included in this repository. A user-provided model may have separate redistribution restrictions. ELSim must preserve provenance and license status and must not publish a model merely because it can parse or simulate it.
