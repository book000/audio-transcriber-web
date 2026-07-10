# Copilot code review instructions

Browser-based speech-to-text transcriber: a vanilla-JS/jQuery static frontend
(`static/`) using the Web Speech API, plus two interchangeable backends that persist
transcripts — `main.py` (FastAPI) and `api.php` (PHP).

There is no build system, test suite, or linter in this repo. Do not suggest running or
adding `npm`/`pytest`/`eslint` commands that do not exist here.

## Review priorities

- **Backend parity**: `main.py` (`POST /api`) and `api.php` must accept the same request
  body (`startTime`, `timeStamp`, `transcript`, `full`) and produce the same output — a
  filename derived from `startTime` formatted as `YYYY-MM-DD HH-MM-SS`, written as
  `data/<that timestamp>.log` (tab-separated `<timeStamp>s\t<transcript>` lines) and
  `data/<that timestamp>.json`. Flag changes to one backend that are not mirrored in the other.
- **File-writing safety**: both backends write user-derived data to `data/`. The filename
  currently comes only from `startTime` run through `datetime`/`date` formatting, which
  constrains it; flag any change that puts raw request values (e.g. `startTime`,
  `transcript`) into a path without that formatting, or otherwise enables path traversal or
  unchecked file writes.
- **Input validation**: request fields come from the browser. Flag missing validation of
  `startTime`/`full` before they are used (e.g. `date()`/`datetime.fromtimestamp`, array
  iteration).
- **Vendored libraries**: `static/axios.min.js`, `static/diff.js`, `static/screenfull.min.js`
  are third-party files committed as-is. Do not review their internals or suggest style
  fixes for them; only flag if a vendored file is edited by hand instead of version-bumped.
- **README sync**: `README.md` and `README-ja.md` mirror each other. Flag setup/feature
  changes applied to only one.

## Do not flag

- Absence of a JS/frontend package manager, JS lockfile, test suite, or CI config — this
  is intentional. (Python deps are the exception: they use `pip` + `requirements.txt`.)
- Global/`var`-style vanilla JS and CDN-loaded jQuery in `static/` — consistent with the
  existing codebase; do not push toward a framework or module bundler.
