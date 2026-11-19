# AGENTS.md

Guidance for AI coding agents and contributors. `CLAUDE.md` imports this file, and `.github/copilot-instructions.md` adds the review checklist.

## Language

- All deliverables are written in **English**: commit messages, PR/Issue titles and bodies, review comments, code comments and docstrings, and documentation (`README.md`, `AGENTS.md`, etc.).
- `README-ja.md` is an intentionally kept Japanese translation of `README.md`. Keep it in sync with `README.md` whenever setup steps, features, or requirements change.
- Exceptions (keep as is): quotations, technical identifiers, generated files, and external source text.
- Runtime messages (logs, errors) are English.
- Do not rewrite Git history to change the language of past commits.

## Overview

Browser-based speech-to-text transcriber. The static frontend (`static/`, vanilla JS plus jQuery) uses the Web Speech API (`SpeechRecognition`, falling back to `webkitSpeechRecognition`) to transcribe microphone audio in real time, shows the results (with recognition alternatives and character diffs on hover), and can POST each finalized transcript to a configurable `API URL`. A small backend writes those POSTs to per-session `.log` and `.json` files under `data/`. The frontend can run standalone (for example from GitHub Pages); the backend is optional.

## Commands

```bash
pip3 install -U -r requirements.txt            # Python backend dependencies (exact-pinned)
python3 main.py --open-browser                 # serve frontend and API on port 8080 (--open-browser also opens a browser)
node tests/speech-recognition-support.test.js  # frontend regression tests (plain Node, no dependencies)
python3 -m unittest discover -s tests -p 'test_*.py'  # HTTP backend regression tests (requires pinned requirements)
```

There is no JS package manager, build step, or JS linter. `.github/workflows/python-ci.yml` (reusable workflow from `book000/templates`) runs Python checks (`compileall`, `ruff check`, `ruff format --check`, `pytest`) with ruff's defaults; pytest also discovers the backend regression tests. Run `ruff check` and `ruff format --check` before pushing Python changes.
To use the frontend alone, open `static/index.html`. To use the PHP backend instead, put `api.php` on any PHP server and point `API URL` at it.

## Structure

- `static/index.html`: page markup. Loads the vendored libraries and `script.js`; jQuery is loaded from a Google CDN.
- `static/script.js`: all recognition logic (starting `SpeechRecognition`, rendering interim and final results, diffing alternatives, POSTing via axios). Tested by loading it in a `node:vm` sandbox.
- `static/style.css`, `static/manifest.json`: styling and PWA manifest.
- `static/axios.min.js`, `static/diff.js` (jsdiff), `static/screenfull.min.js`: vendored third-party libraries. Do not hand-edit them; replace the whole file with a new upstream version.
- `main.py`: FastAPI backend. `HEAD /api` is a health check (the frontend polls it every 10 seconds). `POST /api` takes `startTime`, `revision`, `timeStamp`, `transcript`, and `full`; `revision` is a required positive integer no greater than `9007199254740991` (JavaScript's maximum safe integer). It derives the filename from `startTime` formatted as `YYYY-MM-DD HH-MM-SS` in server-local time. It also serves `static/`.
- `api.php`: standalone PHP equivalent of `POST /api` with the same filename derivation and output. `HEAD` returns 200 with an empty body, as the health check.
- `data/`: runtime output, gitignored.

## Conventions

- Keep `main.py` and `api.php` in parity: when one changes its request shape or output format, change the other to match.
- Both backends write to `data/`. The filename must keep coming only from `startTime` run through date formatting; never put raw request values into a path.
- A per-session `.lock` coordinates requests across processes. The canonical `.snapshot.json` stores the highest accepted `revision` with its `full` array. Older or duplicate revisions must not replace this snapshot. Under the same lock, requests atomically replace `.log` (tab-separated `<timeStamp>s\t<transcript>` lines) and `.json` (the raw `full` array), repairing incomplete exports from the canonical snapshot on later requests. Each file replacement is atomic; simultaneous visibility of all files is not guaranteed.
- Update `README.md` and `README-ja.md` together.
- Pin dependency versions in `requirements.txt`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/); branches follow [Conventional Branch](https://conventional-branch.github.io) short form (`feat/...`, `fix/...`).
- Do not commit to Renovate PRs. Never commit secrets.

## Verification

Run the Node and HTTP backend regression tests above. The backend tests cover reordered and concurrent requests, revision validation, persistence, and export recovery. Also verify microphone recognition manually: run `python3 main.py`, open the page, grant microphone access, record speech, and confirm that results render and that a `data/<YYYY-MM-DD HH-MM-SS>.{log,json}` pair is written.
