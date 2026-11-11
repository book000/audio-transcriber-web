# Copilot code review instructions

See `AGENTS.md` for the project overview, commands, and conventions. Review in English. All deliverables are English; `README-ja.md` is the only intentionally Japanese file (a translation of `README.md`).

## Review priorities

- **Backend parity**: `main.py` and `api.php` must accept the same request body (`startTime`, `timeStamp`, `transcript`, `full`) and write the same `data/<YYYY-MM-DD HH-MM-SS>.log` and `.json` files. Flag a change made to only one.
- **File-writing safety**: the filename must come only from `startTime` run through date formatting. Flag raw request values in a path, path traversal, or unchecked writes.
- **Input validation**: flag missing validation of request fields (`startTime`, `full`) before use.
- **Vendored libraries**: `static/axios.min.js`, `static/diff.js`, `static/screenfull.min.js` are third-party files. Do not review their internals; flag only hand edits.
- **README sync**: flag setup or feature changes applied to only one of `README.md` and `README-ja.md`.
- **Language**: flag non-English comments, docstrings, or documentation (except `README-ja.md`).

## Do not flag

- The absence of a JS package manager, lockfile, linter, build step, or JS CI. This is intentional. (Python dependencies use `pip` + `requirements.txt`, checked by Python CI.)
- Global `var`-style vanilla JS and CDN-loaded jQuery in `static/`. Do not push toward a framework or bundler.
