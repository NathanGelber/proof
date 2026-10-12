# Proof

A small Windows PDF workbench: combine, reorder, rotate, split and extract pages; type, date, sign and place images; fill forms; cover or truly redact; page numbers, Bates numbers, headers, footers and watermarks; strip metadata, compress, password-protect. Everything runs locally.

- **UI:** Tauri 2 (WebView2) with plain JS, bundled by Vite. The page itself has no network access (its Content-Security-Policy only allows the app's own files and IPC).
- **Engines:** pdf.js renders, pdf-lib assembles, MuPDF (WASM) unlocks, redacts, compresses and encrypts.
- **Text you add** uses the system's Arial, so non-Latin scripts work.

## KYC profile

**Profile** in the toolbar keeps a single source of truth for KYC/CDD answers: entities, the people behind them (directors, UBOs, signatories, members, shareholders), stored documents with issue dates, and custom items. Every value keeps its history.

**Fill from profile** (toolbar) fills what Proof is sure of straight onto the form and shows it on the pages: green for confident answers, amber for ones to check. A short list in the Form tab holds only what needs you; click a field on the page or a row in the list to change what goes in it, or type a missing value once and it's saved to the profile. Claude runs on whatever's left, if switched on. Proof asks who the form is for once, at save, and that's when the fill is recorded and the labels are learned. Fillable forms get their fields filled; flat forms get answers typed onto the page, which you can drag into place. Word (.docx) and Excel (.xlsx) forms open in their own view, a preview with the answers highlighted beside the same list, and are saved as a filled copy in their own format: Proof writes into empty cells beside labels, rows under table headers, blanks, content controls, legacy form fields and tick boxes, and leaves formatting, validation and protection alone. Old .doc/.xls files need saving as .docx/.xlsx first. Reviewed matches are remembered per form, so the same form comes back filled. Each fill is recorded with the values as they were (Profile → Fill record). **Attach documents** appends stored documents and warns when an extract is older than counterparties usually accept.

How the data is kept apart from the matching:

- **Storage.** One encrypted file (`kyc.vault`, in the app data folder unless you choose another location) plus a `kyc.vault.files` folder of encrypted documents. Argon2id derives a key from the passphrase that wraps a random data key; XChaCha20-Poly1305 encrypts the profile and each document. Locks after 15 minutes without use. A profile in a shared folder works: Proof refuses to overwrite a file someone else saved after you opened it, and asks.
- **Matching.** In order: saved forms (a form you filled before), the label library (wording you've confirmed, learned from every fill and seeded with **Profile → Label library → Learn from forms…**), then built-in phrase lists (`src/kyc/match.js`). The optional Claude step only gets what's left. It runs in the Rust backend (`src-tauri/src/matcher.rs`), the only code that can reach the network, and sends only each answer spot's label text plus the *names* of profile items, never values: no file name, letterhead, instructions or surrounding lines. The request types reject unknown fields; emails, URLs, phone and account numbers, dates and long numbers are masked; the counterparty's name and anything matching the unlocked profile are cut (`src-tauri/src/scrub.rs`). **What gets sent?** in the review shows the exact request.
- **API key.** Stored in Windows Credential Manager by the backend; the page can set it but never read it.

## Build

Pushing to `main` builds the Windows installers on GitHub Actions (`.github/workflows/windows.yml`). Download them from the run's **Proof-installer** artifact.

Locally on Windows: install Node 22 and Rust, then `npm ci` and `npx tauri build`.
For UI work in a browser: `npm run dev`.

## License note

MuPDF is AGPL-3.0. Fine for personal use; distributing Proof to others means releasing its source under the AGPL.
