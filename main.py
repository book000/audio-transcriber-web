import json
import math
import os
import sys
import webbrowser
from contextlib import contextmanager
from tempfile import NamedTemporaryFile
from time import localtime, strftime
from typing import Annotated

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import AfterValidator, BaseModel, Field, field_validator

app = FastAPI()


MAX_TIMESTAMP = 4102444799
MAX_TRANSCRIPT_BYTES = 65536
MAX_FULL_ENTRIES = 10000
MAX_FULL_BYTES = 1048576


def validate_transcript(value):
    if len(value.encode("utf-8")) > MAX_TRANSCRIPT_BYTES:
        raise ValueError("Transcript exceeds the UTF-8 byte limit")
    return value


TranscriptText = Annotated[
    str,
    Field(strict=True, max_length=MAX_TRANSCRIPT_BYTES),
    AfterValidator(validate_transcript),
]


class TranscriptEntry(BaseModel):
    timeStamp: Annotated[int, Field(strict=True, ge=0, le=MAX_TIMESTAMP)]
    transcript: TranscriptText


class DataModel(BaseModel):
    startTime: Annotated[int, Field(strict=True, ge=0, le=MAX_TIMESTAMP)]
    revision: Annotated[int, Field(strict=True, gt=0, le=9007199254740991)]
    transcript: TranscriptText
    full: Annotated[list[TranscriptEntry], Field(max_length=MAX_FULL_ENTRIES)]

    @field_validator("startTime", mode="before")
    @classmethod
    def truncate_start_time(cls, value):
        # The frontend sends fractional epoch seconds.
        if type(value) is float:
            if not math.isfinite(value) or not 0 <= value < MAX_TIMESTAMP + 1:
                raise ValueError("Invalid recording start time")
            return int(value)
        return value

    @field_validator("full")
    @classmethod
    def validate_full_size(cls, items):
        if sum(len(item.transcript.encode("utf-8")) for item in items) > MAX_FULL_BYTES:
            raise ValueError("Snapshot exceeds the UTF-8 byte limit")
        return items


@app.exception_handler(RequestValidationError)
async def invalid_snapshot(request, error):
    # Validation inputs may include non-finite numbers that JSON cannot encode.
    return JSONResponse(status_code=422, content={"detail": "Invalid snapshot"})


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
    try:
        save_snapshot(data)
    except OSError as error:
        raise HTTPException(status_code=500, detail="Cannot save snapshot") from error


def save_snapshot(data):
    # Server-local time keeps the session filename consistent with api.php.
    timestamp = strftime("%Y-%m-%d %H-%M-%S", localtime(data.startTime))
    directory = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(directory, exist_ok=True)
    base = os.path.join(directory, timestamp)
    with session_lock(base + ".lock"):
        snapshot_path = base + ".snapshot.json"
        snapshot = {
            "revision": data.revision,
            "full": [item.model_dump() for item in data.full],
        }
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
