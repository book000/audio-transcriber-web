import json
import os
import sys
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timezone
from tempfile import NamedTemporaryFile

import uvicorn
from fastapi import FastAPI, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, conint, validator

app = FastAPI()


class DataModel(BaseModel):
    startTime: int
    revision: conint(strict=True, gt=0, le=9007199254740991)
    transcript: str
    full: list

    @validator("full")
    def validate_full(cls, items):
        for item in items:
            if not isinstance(item, dict):
                raise TypeError("Invalid transcript entry")
            timestamp = item.get("timeStamp")
            transcript = item.get("transcript")
            if type(timestamp) is not int or not isinstance(transcript, str):
                raise ValueError("Invalid transcript entry")
        return items


@app.get("/")
def root():
    with open(os.path.dirname(os.path.abspath(__file__)) + "/static/index.html") as f:
        return Response(content=f.read(), media_type="text/html")


@app.head("/api")
def head_api():
    return Response(content="Successful")


@contextmanager
def session_lock(path):
    with open(path, "a+b") as lock:
        if os.name == "nt":
            import msvcrt

            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def atomic_write(path, content):
    temporary = None
    try:
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=os.path.dirname(path), delete=False
        ) as output:
            temporary = output.name
            output.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


@app.post("/api")
def main(data: DataModel):
    # Server-local time keeps the session filename consistent with api.php.
    timestamp = (
        datetime.fromtimestamp(data.startTime, timezone.utc)
        .astimezone()
        .strftime("%Y-%m-%d %H-%M-%S")
    )
    directory = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(directory, exist_ok=True)
    base = os.path.join(directory, timestamp)
    with session_lock(base + ".lock"):
        snapshot_path = base + ".snapshot.json"
        snapshot = {"revision": data.revision, "full": data.full}
        if os.path.exists(snapshot_path):
            with open(snapshot_path, encoding="utf-8") as saved:
                previous = json.load(saved)
            if previous["revision"] >= data.revision:
                snapshot = previous
        full_text = "\n".join(
            "{timeStamp}s\t{transcript}".format(**item) for item in snapshot["full"]
        )
        # Persist the revision with its data first so retries can repair incomplete exports.
        atomic_write(snapshot_path, json.dumps(snapshot))
        atomic_write(base + ".log", full_text)
        atomic_write(base + ".json", json.dumps(snapshot["full"]))


app.mount("/", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--open-browser":
        if os.path.exists(
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
        ):
            webbrowser.get(
                r'"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" %s &'
            ).open("http://localhost:8080/")
        else:
            webbrowser.open("http://localhost:8080")

    uvicorn.run(app, host="0.0.0.0", port=8080)
