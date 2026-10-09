# ELSim project files

The native project extension is `.elsim`. Version 1 is a ZIP archive using ZIP's **stored** (uncompressed) method so it can be generated and opened in browsers without a native helper or third-party ZIP code.

## Layout

```text
manifest.json
project.json
assets/                 # reserved; currently no project assets are supported
```

`manifest.json` follows [`schemas/archive-v1.schema.json`](schemas/archive-v1.schema.json). It identifies the archive version, the `project.json` byte length and CRC-32, and a table of asset paths, byte lengths, media types, CRC-32 values, and optional SHA-256 digests. Version 1 currently requires an empty `assets` array. Model import will extend this before model files can be embedded.

`project.json` is the versioned document described by [`schemas/project-v2.schema.json`](schemas/project-v2.schema.json). The archive wraps the project without changing its document version. Existing standalone `.elsim.json` files remain readable.

## Reader limits

The browser reader accepts only ZIP stored entries with UTF-8 names, a single disk, no encryption, and no ZIP64. It rejects absolute paths, drive paths, backslashes, `.`/`..` path segments, duplicate names, mismatched local/central headers, overlapping entries, CRC failures, and unknown archive contents. Archives are limited to 50 MiB total, 20 MiB per entry, and 64 entries. These limits apply before project JSON is parsed. The writer uses fixed ZIP timestamps and stable entry ordering for deterministic output.

CRC-32 detects accidental corruption; it is not an authenticity or security signature. Future embedded assets must have recorded provenance and licenses. A user having a model file does not imply permission to redistribute it.
