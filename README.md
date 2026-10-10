# Proof

A small Windows PDF workbench: combine, reorder, rotate, split and extract pages; type, date, sign and place images; fill forms; cover or truly redact; page numbers, Bates numbers, headers, footers and watermarks; strip metadata, compress, password-protect. Everything runs locally.

- **UI:** Tauri 2 (WebView2) with plain JS, bundled by Vite. No network access at runtime.
- **Engines:** pdf.js renders, pdf-lib assembles, MuPDF (WASM) unlocks, redacts, compresses and encrypts.
- **Text you add** uses the system's Arial, so non-Latin scripts work.

## Build

Pushing to `main` builds the Windows installers on GitHub Actions (`.github/workflows/windows.yml`). Download them from the run's **Proof-installer** artifact.

Locally on Windows: install Node 22 and Rust, then `npm ci` and `npx tauri build`.
For UI work in a browser: `npm run dev`.

## License note

MuPDF is AGPL-3.0. Fine for personal use; distributing Proof to others means releasing its source under the AGPL.
