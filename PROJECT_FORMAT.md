# ELSim project files

The native project extension is `.elsim`. Version 1 is a ZIP archive using ZIP's **stored** (uncompressed) method so it can be generated and opened in browsers without a native helper or third-party ZIP code.

## Layout

```text
manifest.json
project.json
assets/                 # reserved; currently no project assets are supported
```

`manifest.json` follows [`schemas/archive-v1.schema.json`](schemas/archive-v1.schema.json). It identifies the archive version, the `project.json` byte length and CRC-32, and a table of asset paths, byte lengths, media types, CRC-32 values, and optional SHA-256 digests. Version 1 currently requires an empty `assets` array. User-imported model libraries are stored as text in the optional `project.json` `modelAssets` field; they are not repository assets and keep an unknown redistribution status until reviewed by the user.

`project.json` is the versioned document described by [`schemas/project-v2.schema.json`](schemas/project-v2.schema.json). The archive wraps the project without changing its document version. Existing standalone `.elsim.json` files remain readable.

Project version 2 optionally stores `plotSettings` with selected trace IDs and independent normalized horizontal view ranges for transient, AC, and DC sweep plots. Readers add empty plot settings when opening older version 2 projects. Plot preferences do not change the electrical revision timestamp. Simulation samples themselves are not embedded; saved trace IDs are restored when a compatible simulation result is produced again.

Parts may optionally store `flipX` (`true` for a horizontal symbol flip). It is presentation state: the electrical pin indexes remain stable, and connected wire endpoints move with their indexed pins. Older version 2 files without this property are interpreted as unflipped.

An imported subcircuit instance uses `kind: "subcircuit"`, an `X` reference designator, `modelName`, and `modelPins` in declared SPICE order. Pin locations derive from the stored ordered names, and project validation requires an exact match with a subcircuit definition in `modelAssets`. The netlister emits an `X` instance and its project-owned library text. Removing a library used by instances is blocked in the editor. This does not guarantee every vendor model dialect is supported; ngspice remains the compatibility authority.

Project version 2 may include up to 16 `modelAssets`. Each records the user-selected filename, original UTF-8 text, SHA-256 digest, import time, and `licenseStatus: "unknown"`. Libraries must contain at least one complete `.SUBCKT`, may define shared `.MODEL`, `.PARAM`, `.FUNC`, and `.GLOBAL` records, and may not contain external includes or control/end directives. Current limit is 4 MiB per library and 10 MiB total. Importing does not grant redistribution rights; imported text stays local to the project archive and is not uploaded by ELSim.

## Reader limits

The browser reader accepts only ZIP stored entries with UTF-8 names, a single disk, no encryption, and no ZIP64. It rejects absolute paths, drive paths, backslashes, `.`/`..` path segments, duplicate names, mismatched local/central headers, overlapping entries, CRC failures, and unknown archive contents. Archives are limited to 50 MiB total, 20 MiB per entry, and 64 entries. These limits apply before project JSON is parsed. The writer uses fixed ZIP timestamps and stable entry ordering for deterministic output.

CRC-32 detects accidental corruption; it is not an authenticity or security signature. Future embedded assets must have recorded provenance and licenses. A user having a model file does not imply permission to redistribute it.
