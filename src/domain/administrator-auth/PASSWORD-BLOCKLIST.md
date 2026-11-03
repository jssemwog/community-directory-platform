# `password-blocklist.txt` — provenance

The offline blocklist behind the administrator password policy (`ADR-004` P-2 and L-2; issue #260
§2, OD-2 and §12 qualification 7). `password-policy.ts` reads it; nothing fetches anything at sign-in
or at provisioning.

## Source

| | |
|---|---|
| Repository | [`danielmiessler/SecLists`](https://github.com/danielmiessler/SecLists) |
| Commit | `68bcd12457978649d41ae4f56e3b5d2db2b72560` (default branch `master`, read 2026-11-02) |
| Licence | MIT, at repository level (`LICENSE`, "Copyright (c) 2018 Daniel Miessler") |

| Source file (`Passwords/Common-Credentials/`) | SHA-256 at that commit |
|---|---|
| `Pwdb_top-1000000.txt` | `e9a88f67aafe65496682dc374559ee714e978bee50314767494c3e37a18c9fc8` |
| `xato-net-10-million-passwords-1000000.txt` | `424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51` |
| `100k-most-used-passwords-NCSC.txt` | `c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0` |

## Derivation

`scripts/local-demo/build-password-blocklist.mjs`, run offline over those three files in that order:
each line is NFC-normalized and lower-cased, only entries of **15 to 128 code points** are kept
(shorter ones can never match a password the policy accepts), and the result is deduplicated,
sorted by code unit and newline-terminated.

| Output | Value |
|---|---|
| Entries | 16,051 |
| SHA-256 (LF line endings) | `989230851cc04f15556762be404faccfb9efcb9f1dbaa020bd9cb157a746b0ec` |

**Update route:** download the three files at a newly chosen commit, rerun the script, update this
note, and review the change. That happens only by an explicit decision; nothing updates the list
automatically.

## Limits, disclosed

- **Licence uncertainty.** The repository-level MIT licence is the only licence evidence found.
  **No per-file licence or redistribution term was found** for these files, and the underlying
  entries come from leaked-password corpora that SecLists redistributes. No concrete
  redistribution restriction was found when this was checked (2026-11-02, the repository `LICENSE`,
  `README.md` and `Passwords/README.md`). If one is found, the list is to be removed and replaced.
- **Suitability limit.** The list was chosen for **synthetic local accounts** (#254). `ADR-004`
  asks for a list of "sufficient size" and sets no number; only about 0.5–1 % of each source is
  long enough to matter at a 15-character minimum. Whether a larger corpus, such as a full breach
  corpus, is needed is a question for the security review (`ADR-004` R-4) before any public
  reachability.
- Matching is case-insensitive after NFC (OD-2), which is stricter than an exact comparison.
