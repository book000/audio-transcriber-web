# CLAUDE.md

## Overview

Browser-based speech-to-text transcriber. The static frontend uses the Web Speech
API (`webkitSpeechRecognition`) to transcribe microphone audio in real time, shows
the results (with recognition alternatives on hover), and can POST each transcript to
a configurable `API URL`. A small backend receives those POSTs and writes them to
per-session `.log` and `.json` files under `data/` — each POST sends the full transcript
so far, and the backend overwrites that session's files with it (it does not append).

The frontend can run standalone from GitHub Pages; the backend is optional and only
needed if you want transcripts saved to disk.

## Running

There is no build step, JS/frontend package manager, test suite, or linter in this
repository. Python dependencies are the one exception: they are managed with `pip` +
`requirements.txt` (see the Python backend below).

- Frontend only: open `static/index.html` (or the GitHub Pages URL). No server needed.
- Python backend:
  - `pip3 install -U -r requirements.txt` (FastAPI + uvicorn, pinned versions)
  - `python3 main.py --open-browser` — serves the frontend and API on port `8080`.
    `--open-browser` also launches a browser (Chrome path is hardcoded for Windows,
    otherwise falls back to the default browser).
  - Set the `API URL` field in the UI to `http://localhost:8080/api`.
- PHP backend: place `api.php` on any PHP server and point `API URL` at it. It is a
  standalone equivalent of the Python `POST /api` handler.

Browser support: Chrome 33+ / Edge 79+ (Web Speech API required).

## Architecture / key files

- `static/index.html` — page markup; loads the vendored libs and `script.js`. jQuery
  is loaded from a Google CDN (the only external runtime dependency).
- `static/script.js` — all recognition logic: starts `SpeechRecognition`, renders
  interim/final results, diffs alternatives, and POSTs finalized transcripts via axios.
- `static/style.css`, `static/manifest.json` — styling and PWA manifest.
- `static/axios.min.js`, `static/diff.js` (kpdecker's `diff` / jsdiff), `static/screenfull.min.js`
  — vendored third-party libraries, committed as-is. Do not hand-edit these.
- `main.py` — FastAPI backend. `POST /api` derives a filename from `startTime`, formatted
  as `YYYY-MM-DD HH-MM-SS` (via `datetime.fromtimestamp(...).strftime(...)`), and writes
  `data/<that timestamp>.log` (tab-separated `<timeStamp>s\t<transcript>` lines) and
  `data/<that timestamp>.json` (raw `full` array).
- `api.php` — PHP backend implementing the same request/response contract and file
  output format as `main.py` (same `date("Y-m-d H-i-s", startTime)` filename derivation).
- `data/` — runtime output, gitignored. Not committed.

## Conventions

- `main.py` and `api.php` implement the same API contract (request body: `startTime`,
  `timeStamp`, `transcript`, `full`; output: matching `.log` + `.json` files). When you
  change one backend's request shape or output format, change the other to match.
- Vendored libraries live in `static/` and are edited only by replacing the whole file
  with a new upstream version.
- Pin dependency versions in `requirements.txt` (existing entries are exact-pinned).

## Documentation

- `README.md` (English) and `README-ja.md` (Japanese) are kept in sync — update both
  when changing setup steps, features, or requirements.

## Verification

No automated tests exist. Verify changes manually: run `python3 main.py`, open the page,
grant microphone access, record speech, and confirm results render and that a
`data/<YYYY-MM-DD HH-MM-SS>.{log,json}` pair (named from the session start time) is
written with the expected content.
