function start_recognition(recognitionId) {
    document.getElementById("startstop").innerHTML = "Stop recording";
    SpeechRecognition = webkitSpeechRecognition || SpeechRecognition;
    recognition = new SpeechRecognition();
    const listening = new Listening(recognitionId);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "ja";
    recognition.maxAlternatives = 3;
    recognition.onresult = function (event) {
        console.log(event);
        for (var i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                listening.end(event.resultIndex, Math.floor(event.timeStamp / 1000), event.results[i]);
            } else {
                listening.runResults(event.resultIndex, Math.floor(event.timeStamp / 1000), event.results[i]);
            }
        }
    };
    recognition.onend = function (event) {
        console.log("onend", event);
        document.getElementById("status-circle").style.backgroundColor = "red";
        listening.remove();
        if (started) start_recognition(recognitionId + 1);
    };
    recognition.onstart = function (event) {
        console.log("onstart", event);
        document.getElementById("status-circle").style.backgroundColor = "cyan";
    };
    recognition.onaudiostart = function (event) {
        console.log("onaudiostart", event);
        document.getElementById("status-circle").style.backgroundColor = "limegreen";
    };
    recognition.onaudioend = function (event) {
        console.log("onaudioend", event);
        document.getElementById("status-circle").style.backgroundColor = "cyan";
    };
    recognition.onspeechstart = function (event) {
        console.log("onspeechstart", event);
        document.getElementById("status-circle").style.backgroundColor = "lime";
    };
    recognition.onspeechend = function (event) {
        console.log("onspeechend", event);
        document.getElementById("status-circle").style.backgroundColor = "limegreen";
    };
    recognition.onerror = function (event) {
        console.log("onerror", event);
        document.getElementById("status-circle").style.backgroundColor = "red";
        document.getElementById("status-message").innerHTML = event.error;
    };
    recognition.start();
}
class Listening {
    constructor(recognitionId) {
        this.recognitionId = recognitionId;
        this.listeningElement = document.getElementById("listening")
        this.recognitionElement = document.createElement("div");
        this.recognitionElement.classList.add("listening-recognition");
        this.recognitionElement.id = "recognition-" + recognitionId;
        this.listeningElement.appendChild(this.recognitionElement);
        this.timeStamp = [];
    }

    start(resultId) {
        const resultsElem = document.createElement("ul")
        resultsElem.classList.add("listening-results");
        resultsElem.id = "results-" + resultId;
        this.recognitionElement.appendChild(resultsElem);
    }

    runResults(resultId, timeStamp, results) {
        let resultsElem = document.getElementById("results-" + resultId);
        if (resultsElem == null) {
            this.start(resultId);
            resultsElem = document.getElementById("results-" + resultId);
        }
        while (resultsElem.lastElementChild != null) {
            resultsElem.removeChild(resultsElem.lastElementChild);
        }

        if (this.timeStamp[resultId] == undefined || this.timeStamp[resultId] == null) {
            this.timeStamp[resultId] = timeStamp;
        }

        for (let result of Array.from(results)) {
            const resultElem = document.createElement("li");

            const secElem = document.createElement("span");
            secElem.classList.add("result-sec");
            secElem.textContent = this.timeStamp[resultId] + "s";
            resultElem.appendChild(secElem);

            const percentElem = document.createElement("span");
            percentElem.classList.add("result-percent");
            percentElem.textContent = Math.round(result.confidence * 100) + "%";
            resultElem.appendChild(percentElem);

            const contentElem = document.createElement("span");
            contentElem.classList.add("result-content");
            contentElem.textContent = result.transcript;
            resultElem.appendChild(contentElem);

            resultsElem.appendChild(resultElem);
        }
    }

    end(resultId, timeStamp, results) {
        const resultsElem = document.getElementById("results-" + resultId);
        if (resultsElem == null) {
            return;
        }
        resultsElem.remove();

        if (this.timeStamp[resultId] == undefined || this.timeStamp[resultId] == null) {
            this.timeStamp[resultId] = timeStamp;
        }

        const transcript = results[0].transcript
        fullData.push({
            "timeStamp": this.timeStamp[resultId],
            "transcript": transcript,
            "alternatives": Array.from(results).slice(1).map(x => x.transcript)
        });

        const messages = document.getElementById("messages");
        const message_line = document.createElement("div");
        message_line.classList.add("message-line");

        const message_date = document.createElement("span");
        message_date.classList.add("message-sec");
        message_date.textContent = this.timeStamp[resultId] + "s";
        message_line.appendChild(message_date);

        const message_text = document.createElement("span");
        message_text.classList.add("message-text");
        message_text.innerHTML = transcript;
        message_line.appendChild(message_text);

        const alt_messages = document.createElement("ul");
        alt_messages.classList.add("alt-messages");

        for (const alt of Array.from(results).slice(1).map(x => x.transcript)) {
            const alt_message = document.createElement("li");
            const fragment = document.createDocumentFragment();
            const diff = JsDiff["diffChars"](transcript, alt)
            for (let i = 0; i < diff.length; i++) {
                if (diff[i].added && diff[i + 1] && diff[i + 1].removed) {
                    const swap = diff[i];
                    diff[i] = diff[i + 1];
                    diff[i + 1] = swap;
                }

                let node;
                if (diff[i].removed) {
                    node = document.createElement('del');
                    node.appendChild(document.createTextNode(diff[i].value));
                } else if (diff[i].added) {
                    node = document.createElement('ins');
                    node.appendChild(document.createTextNode(diff[i].value));
                } else {
                    node = document.createTextNode(diff[i].value);
                }
                fragment.appendChild(node);
            }
            alt_message.textContent = '';
            alt_message.appendChild(fragment);
            alt_messages.appendChild(alt_message);
        }

        message_line.appendChild(alt_messages);

        messages.appendChild(message_line);
        messages.scrollTop = messages.scrollHeight;

        sendResult(this.timeStamp[resultId], transcript);
    }

    remove() {
        this.recognitionElement.remove();
    }
}

function sendResult(timeStamp, transcript) {
    const apiurl = document.getElementById("api_url").value;
    if (apiurl == "") {
        return;
    }
    axios.post(apiurl, {
        startTime: startTime,
        timeStamp: timeStamp,
        transcript: transcript,
        full: fullData
    })
        .then(function (response) {
            if (response.status != 200) {
                console.error(response);
            }
        }).catch(function (error) {
            console.error(error);
        });
}

function checkAPIURL() {
    if (!started) {
        return;
    }
    const apiurl = document.getElementById("api_url").value;
    if (apiurl == "") {
        return;
    }
    if (axios != undefined) {
        const script = document.createElement("script");
        script.type = "text/javascript";
        script.src = "https://unpkg.com/axios/dist/axios.min.js";
    }
    axios.head(apiurl)
        .then(function (response) {
            console.log("API active.");
        })
        .catch(function (error) {
            if (error.response) {
                console.error("API failed[RESPONSE]: " + error.response.status);
                console.error(error.response);
                if (confirm("The API is not working properly(" + error.response.status + "). Close this page?")) {
                    window.close();
                }
            } else if (error.request) {
                console.error("API failed[REQUEST]:");
                console.error(error.request);
                if (confirm("The API is not working properly. Close this page?")) {
                    window.close();
                }
            } else {
                console.error("API failed[ERROR]: " + error.message);
                if (confirm("The API is not working properly(" + error.message + "). Close this page?")) {
                    window.close();
                }
            }
        });
}

function startFullScreen() {
    if (!screenfull.isEnabled) {
        alert("Fullscreen is not supported");
        return;
    }
    screenfull.request(document.getElementById("main")).then(function () {
        console.log('Fullscreen mode: ' + (screenfull.isFullscreen ? 'enabled' : 'disabled'));
        if (screenfull.isFullscreen) {
            document.getElementById("fullscreen").innerHTML = "Stop fullscreen";
        }
    });
}

function stopFullScreen() {
    if (!screenfull.isEnabled) {
        alert("Fullscreen is not supported");
        return;
    }
    screenfull.exit();
    document.getElementById("fullscreen").innerHTML = "Start fullscreen";
}

function isFullScreen() {
    return document.fullscreenElement || document.mozFullScreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
}

fullData = [];
started = false;
onload();

function onload() {
    const apiurl = localStorage.getItem("audio-transcriber-web-api-url");
    if (apiurl != null) {
        document.getElementById("api_url").value = apiurl;
    }
    const autoStart = localStorage.getItem("audio-transcriber-web-auto-start");
    if (autoStart != null) {
        document.getElementById("auto-start").checked = autoStart.toLowerCase() === "true";
    }
    if (document.getElementById("auto-start").checked) {
        started = true;
        startTime = new Date().getTime() / 1000;
        start_recognition(0);
    }

    setInterval(checkAPIURL, 10000);
}

document.getElementById("api_url").onchange = function () {
    localStorage.setItem("audio-transcriber-web-api-url", document.getElementById("api_url").value);
}
document.getElementById("auto-start").onchange = function () {
    localStorage.setItem("audio-transcriber-web-auto-start", document.getElementById("auto-start").checked.toString());
}
document.getElementById("startstop").onclick = function () {
    if (!started) {
        started = true;
        startTime = new Date().getTime() / 1000;
        start_recognition(0);
    } else {
        document.getElementById("startstop").innerHTML = "Start recording";
        started = false;
        recognition.stop();
        recognition = null;
    }
}
document.getElementById("fullscreen").onclick = function () {
    if (!screenfull.isFullscreen) {
        startFullScreen();
    } else {
        stopFullScreen();
    }
}