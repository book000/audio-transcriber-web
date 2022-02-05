# coding: utf-8
import uvicorn
from datetime import datetime
import json
import os
import webbrowser
import sys

from fastapi import FastAPI, Body, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()


class DataModel(BaseModel):
    startTime: int
    timeStamp: int
    transcript: str
    full: list


@app.get("/")
def root():
    with open(os.path.dirname(os.path.abspath(__file__)) + "/static/index.html") as f:
        return Response(content=f.read(), media_type="text/html")

@app.head("/api")
def main():
    return Response(content="Successful")

@app.post("/api")
def main(data: DataModel = Body(...)):
    fullText = map(lambda data: "{timeStamp}s\t{transcript}".format(
        timeStamp=data.get("timeStamp"), transcript=data.get("transcript")), data.full)
    fullText = "\n".join(fullText)
    timeStamp = datetime.fromtimestamp(
        data.startTime).strftime("%Y-%m-%d %H-%M-%S")

    if not os.path.exists(os.path.dirname(os.path.abspath(__file__)) + "/data/"):
        os.mkdir(os.path.dirname(os.path.abspath(__file__)) + "/data/")

    with open(os.path.dirname(os.path.abspath(__file__)) + "/data/" + timeStamp + ".log", "w") as f:
        f.write(fullText)

    with open(os.path.dirname(os.path.abspath(__file__)) + "/data/" + timeStamp + ".json", "w") as f:
        f.write(json.dumps(data.full))


app.mount("/", StaticFiles(directory="static"), name="static")


if len(sys.argv) >= 2 and sys.argv[1] == "--open-browser":
    if os.path.exists("C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
        webbrowser.get('"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" %s &').open(
            "http://localhost:8080/")
    else:
        webbrowser.open("http://localhost:8080")

uvicorn.run(app, host="0.0.0.0", port=8080)
