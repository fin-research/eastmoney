# Vendored SheetJS

`xlsx-0.20.3.tgz` is the unchanged SheetJS CE 0.20.3 package from
[the official CDN](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz).
`xlsx-LICENSE.txt` reproduces its Apache-2.0 license verbatim; the archive also contains that license.

The root catalog fixes version 0.20.3, and a single root override selects this local archive.
The existing dependency lock recorded this integrity before vendoring:

```text
sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==
```

The downloaded archive matched that value byte for byte. The dependency guard verifies it before CI installation.
The local source avoids the observed official CDN 503 and stalled downloads without changing package code or version.
SheetJS documents this approach in its [Node.js vendoring instructions](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring).
The public policy permits only this reviewed archive; other vendored dependencies require an explicit policy change.
