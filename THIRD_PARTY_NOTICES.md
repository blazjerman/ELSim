# Third-party notices

ELSim source is distributed under the MIT License in [LICENSE](LICENSE). Third-party software keeps its own terms. The complete locked npm dependency inventory is in [`licenses/npm-dependencies.json`](licenses/npm-dependencies.json). This file includes the full declared license text for direct production dependencies bundled by the current browser build.

After `npm ci`, run `npm run check:npm-licenses` to verify the installed package inventory, exact versions, license-file hashes, and direct dependency notice headings. This check detects stale or missing records; it does not determine license compatibility or replace review of the applicable terms.

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

The reproducible build script writes ngspice files into the Git-ignored `public/engine/` directory. Ordinary `npm run build` disables Vite's public-directory copy and verifies that the output has no `engine/` directory; local development can still load the ignored runtime. Only `npm run build:release` may package ngspice, after the artifact-bound review gate passes. The release build includes the pinned ngspice source tree's `COPYING`, exact source archive, compiled object/archive relinking materials, build-info, Emscripten link map, generated candidate source-path inventory, checksums, this notice, Emscripten's `LICENSE`, and the bundled musl `COPYRIGHT`. Candidate source paths require manual verification against source and per-directory license files; the inventory does not classify licenses or make legal determinations. These files are evidence and notices, not proof that every binary-distribution obligation has been satisfied.

ELSim pins ngspice commit `a80f6e3e95d51534905b1f23410a951802666656` from the [ngspice source repository](https://sourceforge.net/p/ngspice/ngspice/ci/a80f6e3e95d51534905b1f23410a951802666656/tree/). Upstream describes Modified BSD as the default and identifies exceptions in its [`COPYING` file](https://sourceforge.net/p/ngspice/ngspice/ci/a80f6e3e95d51534905b1f23410a951802666656/tree/COPYING), including LGPL-licensed `numparam`, the GPL-licensed XSPICE `table` model, LGPL-licensed KLU/tclspice portions, MIT-licensed sparse code, and MPL-licensed OSDI. XSPICE also contains public-domain code. The current WASM recipe disables KLU and OSDI, removes the GPL `table` model and optional Verilog/VHDL adapters, and does not enable Tcl integration. Since the recipe statically links ngspice and does not disable `numparam`, the shipped engine must be treated as containing LGPL-covered code unless the generated link map and object/source mapping prove otherwise. The build packages upstream source plus `.o`/`.a` files and the link map for a reviewer to assess the LGPL source and relinking requirements. **The exact object set, per-file terms, and whether the supplied materials are sufficient still need verification.**

The Emscripten SDK licenses its code under MIT and the University of Illinois/NCSA Open Source License; its bundled musl libc carries MIT notices. The build copies the SDK's `LICENSE` and musl `COPYRIGHT` beside the generated engine. The actual emitted runtime still needs inspection to confirm which toolchain portions are present and that the included notices cover them.

Do not publish a production bundle containing this runtime until the exact compiled source/object set has been inventoried, the LGPL and any other applicable terms have been satisfied (including source and relinking materials where required), the relevant notices are shipped, and a qualified reviewer has checked the distribution. ELSim's MIT license applies only to ELSim-authored source; it does not relicense ngspice or settle the compatibility of this combined distribution. See [`engine/wasm/README.md`](engine/wasm/README.md) and the M0.2 gate in [`ROADMAP.md`](ROADMAP.md).

`npm run build:release` is the repository's release build entry point. It fails closed unless `licenses/ngspice-distribution-review.json` records a review for the exact generated JavaScript, WASM, upstream source and COPYING, Emscripten and musl notices, linker map, relinking materials, third-party notice, build-info, and checksums. The checked-in [`review template`](licenses/ngspice-distribution-review.template.json) is intentionally not approval. The checker enforces presence and hash binding of review claims; it does not validate the legal conclusions in those claims. GitHub Pages adds no extra software license to ELSim; hosting the release still redistributes every bundled asset under that asset's own terms.

## User-provided models

Imported models are not included in this repository. A user-provided model may have separate redistribution restrictions. ELSim must preserve provenance and license status and must not publish a model merely because it can parse or simulate it.
