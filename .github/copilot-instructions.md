# Copilot code review instructions

See `AGENTS.md` for the project overview, commands, and conventions. Review in English. All deliverables are English; `README-ja.md` is the only intentionally Japanese file (a translation of `README.md`).

## Review priorities

- **Backend parity**: `main.py` and `api.php` must accept the same request body (`startTime`, `revision`, `timeStamp`, `transcript`, `full`) and write the same session snapshots and `.log`/`.json` exports. Flag a change made to only one.
- **API access policy**: require exact comma-separated HTTP(S) origins in `TRANSCRIPT_ALLOWED_ORIGINS` (no wildcard, `null`, or trailing slash) and fail closed with 503 when an allowlist lacks `TRANSCRIPT_API_TOKEN`. A configured token must authenticate all `HEAD`/`POST` requests, including same-origin and no-`Origin` requests; `OPTIONS` preflights must not require authentication. Preserve default trusted-LAN same-origin use, reject foreign origins before writes, and keep the frontend token in page memory without `localStorage` persistence. Require Python and PHP policy coverage in `tests/test_api_access.py` (PHP cases run when `php` is available).
- **File-writing safety**: the filename must come only from `startTime` run through date formatting. A per-session `.lock` must protect the revision check and writes across processes. `.snapshot.json` stores the highest accepted revision with its `full` array; older or duplicate requests must preserve it and repair exports from it. Each file replacement must be atomic; the files are not simultaneously visible as a group. Flag raw request values in a path, path traversal, or unchecked writes.
- **Input validation**: flag missing validation of request fields (`startTime`, `full`) before use. `revision` must be a required positive integer no greater than `9007199254740991` (JavaScript's maximum safe integer).
- **Upload ordering**: process recognition results from `event.resultIndex` without duplicate final-result uploads, and serialize snapshot POSTs. Regression tests must cover reordered backend requests; run both the Node suite and `python3 -m unittest discover -s tests -p 'test_*.py'` with the pinned backend requirements installed.
- **Vendored libraries**: `static/axios.min.js`, `static/diff.js`, `static/screenfull.min.js` are third-party files. Do not review their internals; flag only hand edits.
- **README sync**: flag setup or feature changes applied to only one of `README.md` and `README-ja.md`.
- **Language**: flag non-English comments, docstrings, or documentation (except `README-ja.md`).

## Do not flag

- The absence of a JS package manager, lockfile, linter, build step, or JS CI. This is intentional. (Python dependencies use `pip` + `requirements.txt`, checked by Python CI.)
- Global `var`-style vanilla JS and CDN-loaded jQuery in `static/`. Do not push toward a framework or bundler.
