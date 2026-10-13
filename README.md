# Proof

A small Windows PDF workbench: combine, reorder, rotate, split and extract pages; type, date, sign and place images; fill forms; cover or truly redact; page numbers, Bates numbers, headers, footers and watermarks; strip metadata, compress, password-protect. Everything runs locally.

- **UI:** Tauri 2 (WebView2) with plain JS, bundled by Vite. The page itself has no network access (its Content-Security-Policy only allows the app's own files and IPC).
- **Engines:** pdf.js renders, pdf-lib assembles, MuPDF (WASM) unlocks, redacts, compresses and encrypts.
- **Text you add** uses the system's Arial, so non-Latin scripts work.

## KYC tab

Proof opens on the PDF tab; KYC work lives in its own **KYC** tab and stays out of the editor. The first visit sets up the profile there (entity name and passphrase).

The profile keeps a single source of truth for KYC/CDD answers: entities, the people behind them (directors, UBOs, signatories, members, shareholders), stored documents with issue dates, and custom items. Every value keeps its history.

**Build your profile from a form you've filled before** reads the answers from a filled PDF, Word or Excel form (form fields, label: answer lines, tables, ticked boxes), matches them to profile items and shows each one before anything is saved; values that would replace what you have start unticked. Matching uses the labels only, as below.

**Open form** (KYC tab) fills what Proof is sure of straight onto the form and shows it on the pages: green for confident answers, amber for ones to check. A short list beside the form holds only what needs you; click a field on the page or a row in the list to change what goes in it, or type a missing value once and press Tab: it's saved to the profile and the cursor moves to the next one. Claude runs on whatever's left, if switched on. Proof asks who the form is for once, at save (a PDF is saved as a " - filled" copy), and that's when the fill is recorded and the labels are learned. Fillable forms get their fields filled; flat forms get answers typed onto the page, which you can drag into place. Word (.docx) and Excel (.xlsx) forms open in their own view, a preview with the answers highlighted beside the same list, and are saved as a filled copy in their own format: Proof writes into empty cells beside labels, rows under table headers, blanks, content controls, legacy form fields and tick boxes, and leaves formatting, validation and protection alone. Old .doc/.xls files need saving as .docx/.xlsx first. Reviewed matches are remembered per form, so the same form comes back filled. Each fill is recorded with the values as they were (KYC → Fill record). **Attach documents** appends stored documents and warns when an extract is older than counterparties usually accept.

How the data is kept apart from the matching:

- **Storage.** One encrypted file (`kyc.vault`, in the app data folder unless you choose another location) plus a `kyc.vault.files` folder of encrypted documents. Argon2id derives a key from the passphrase that wraps a random data key; XChaCha20-Poly1305 encrypts the profile and each document. Locks after 15 minutes without use. A profile in a shared folder works: Proof refuses to overwrite a file someone else saved after you opened it, and asks.
- **Matching.** In order: saved forms (a form you filled before), the label library (wording you've confirmed, learned from every fill and seeded with **KYC → Label library → Learn from forms…**), then built-in phrase lists (`src/kyc/match.js`). The optional Claude step only gets what's left. It runs in the Rust backend (`src-tauri/src/matcher.rs`), the only code that can reach the network, and sends only each answer spot's label text plus the *names* of profile items, never values: no file name, letterhead, instructions or surrounding lines. The request types reject unknown fields; emails, URLs, phone and account numbers, dates and long numbers are masked; the counterparty's name and anything matching the unlocked profile are cut (`src-tauri/src/scrub.rs`). **What gets sent?** in the review shows the exact request.
- **API key.** Stored in Windows Credential Manager by the backend; the page can set it but never read it.
- **Saved signature.** Kept in the encrypted profile. Older versions stored it in the window's storage; it's moved in and wiped the first time the profile is unlocked.
- **Files.** The backend only reads PDFs, images, Word, Excel and JSON, and only writes PDFs, PNGs, Word, Excel and JSON, with ordinary full paths. Programs, scripts, shortcuts, device paths and hidden streams are refused. Profile files must end in .vault.
- **Locking.** The backend locks the profile after 15 minutes without use on its own timer and tells the window, which drops the decrypted copy. New passphrases need 12+ characters and can't be trivially guessable.
- **Fill record.** KYC → Settings → Fill record sets how long records are kept; older ones are deleted on unlock.
- **Untrusted files.** Word and Excel files over 50 MB, or that unpack to far more than their size, are refused. pdf.js is 4.10.38 (fixes CVE-2024-4367).
- **Build.** GitHub Actions are pinned to commit SHAs, the workflow token is read-only, and npm and cargo build exactly what the lockfiles say.

## Build

Pushing to `main` builds the Windows installers on GitHub Actions (`.github/workflows/windows.yml`). Download them from the run's **Proof-installer** artifact.

Locally on Windows: install Node 22 and Rust, then `npm ci` and `npx tauri build`.
For UI work in a browser: `npm run dev`.

## License note

MuPDF is AGPL-3.0. Fine for personal use; distributing Proof to others means releasing its source under the AGPL.
