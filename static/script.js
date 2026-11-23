// Keeps the running instance so the stop button can stop it
let currentRecognition = null;
let recognitionRestartTimer = null;
const recognitionRetryDelays = [1000, 2000, 4000];

function stop_recognition(abort = false) {
  started = false;
  clearTimeout(recognitionRestartTimer);
  recognitionRestartTimer = null;
  const recognition = currentRecognition;
  currentRecognition = null;
  document.getElementById("startstop").innerHTML = "Start recording";
  document.getElementById("status-circle").style.backgroundColor = "red";
  listening.remove();
  if (recognition !== null) {
    if (abort) {
      recognition.abort();
    } else {
      recognition.stop();
    }
  }
}

/**
 * Returns the browser's speech recognition constructor.
 * @returns {Function|null} The standard or prefixed constructor, or null if neither exists
 */
function resolveSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

let sessionCounter = 0;

/**
 * Creates a recording session record: one start until stop, uploaded under its own startTime.
 * @returns {{ id: number, startTime: number, revision: number }} startTime is Unix epoch seconds
 */
function newSession() {
  sessionCounter += 1;
  return { id: sessionCounter, startTime: new Date().getTime() / 1000, revision: 0 };
}

function start_recognition(recognitionId, session, retryCount = 0) {
  const RecognitionConstructor = resolveSpeechRecognition();
  if (RecognitionConstructor === null) {
    document.getElementById("status-message").textContent =
      "Speech recognition is not supported in this browser.";
    stop_recognition();
    return;
  }
  document.getElementById("startstop").innerHTML = "Stop recording";
  const recognition = new RecognitionConstructor();
  currentRecognition = recognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  let recognitionError = null;
  let hasFinalTranscript = false;
  recognition.onresult = function (event) {
    console.log(event);
    for (var i = event.resultIndex; i < event.results.length; ++i) {
      const resultId = `${session.id}-${recognitionId}-${i}`;
      if (event.results[i].isFinal) {
        if (event.results[i][0].transcript.trim().length > 0) {
          hasFinalTranscript = true;
          retryCount = 0;
        }
        listening.end(session, resultId, event.timeStamp, event.results[i]);
      } else {
        listening.runResults(resultId, event.timeStamp, event.results[i]);
      }
    }
  };
  recognition.onend = function (event) {
    console.log("onend", event);
    if (currentRecognition !== recognition) {
      return;
    }
    currentRecognition = null;
    document.getElementById("status-circle").style.backgroundColor = "red";
    listening.remove();
    if (recognitionError === null && hasFinalTranscript) {
      start_recognition(recognitionId + 1, session);
      return;
    }
    if (retryCount >= recognitionRetryDelays.length) {
      document.getElementById("status-message").textContent =
        (recognitionError || "Speech recognition ended without a transcript") +
        ". Automatic retries exhausted. Click Start recording to try again.";
      stop_recognition();
      return;
    }
    recognitionRestartTimer = setTimeout(() => {
      recognitionRestartTimer = null;
      if (started) {
        start_recognition(recognitionId + 1, session, retryCount + 1);
      }
    }, recognitionRetryDelays[retryCount]);
  };
  recognition.onstart = function (event) {
    if (currentRecognition !== recognition) {
      return;
    }
    console.log("onstart", event);
    document.getElementById("status-message").textContent = "";
    document.getElementById("status-circle").style.backgroundColor = "cyan";
    listening.recognitionStartHandler(event);
  };
  recognition.onaudiostart = function (event) {
    if (currentRecognition !== recognition) {
      return;
    }
    console.log("onaudiostart", event);
    document.getElementById("status-circle").style.backgroundColor =
      "limegreen";
  };
  recognition.onaudioend = function (event) {
    if (currentRecognition !== recognition) {
      return;
    }
    console.log("onaudioend", event);
    document.getElementById("status-circle").style.backgroundColor = "cyan";
  };
  recognition.onspeechstart = function (event) {
    if (currentRecognition !== recognition) {
      return;
    }
    console.log("onspeechstart", event);
    document.getElementById("status-circle").style.backgroundColor = "lime";
  };
  recognition.onspeechend = function (event) {
    if (currentRecognition !== recognition) {
      return;
    }
    console.log("onspeechend", event);
    document.getElementById("status-circle").style.backgroundColor =
      "limegreen";
  };
  recognition.onerror = function (event) {
    if (currentRecognition !== recognition) {
      return;
    }
    console.log("onerror", event);
    recognitionError = event.error;
    document.getElementById("status-circle").style.backgroundColor = "red";
    document.getElementById("status-message").textContent = event.error;
    if (event.error !== "network" && event.error !== "no-speech") {
      stop_recognition(true);
    }
  };
  try {
    recognition.start();
  } catch (error) {
    document.getElementById("status-message").textContent =
      "Unable to start speech recognition: " + error.message;
    stop_recognition(true);
  }
}

class Listening {
  constructor() {
    this.listeningMessagesManager = new MessagesManager(
      document.getElementById("listening")
    );
    this.messagesManager = new MessagesManager(
      document.getElementById("messages")
    );

    // Unix epoch milliseconds of the page time origin
    this.recognitionStartTimestamp = null;
  }

  recognitionStartHandler(event) {
    this.recognitionStartTimestamp = new Date().getTime() - event.timeStamp;

    const timestampDisplayElement =
      document.getElementById("timestamp-display");
    this.listeningMessagesManager.setDisplayTimestamp(
      timestampDisplayElement.checked
    );
    this.messagesManager.setDisplayTimestamp(timestampDisplayElement.checked);
  }

  runResults(resultId, timeStamp, results) {
    this.listeningMessagesManager.addMessage(resultId, {
      recognitionStartTimestamp: this.recognitionStartTimestamp,
      timeStamp: timeStamp,
      transcript: results[0].transcript,
      confidence: results[0].confidence,
      alternatives: Array.from(results),
    });
  }

  end(session, resultId, timeStamp, results) {
    this.listeningMessagesManager.removeMessage(resultId);

    this.messagesManager.addMessage(resultId, {
      sessionId: session.id,
      recognitionStartTimestamp: this.recognitionStartTimestamp,
      timeStamp: timeStamp,
      transcript: results[0].transcript,
      confidence: results[0].confidence,
      alternatives: Array.from(results),
    });

    sendResult(
      session,
      Math.floor(timeStamp / 1000),
      results[0].transcript,
      this.messagesManager.getFullData(session.id)
    );
  }

  remove() {
    this.listeningMessagesManager.deleteAllMessages();
  }

  getListeningMessagesManager() {
    return this.listeningMessagesManager;
  }

  getMessagesManager() {
    return this.messagesManager;
  }
}

class MessagesManager {
  constructor(targetElement) {
    this.messages = [];
    this.target = targetElement;
    this.isDisplayTimestamp = false;
  }

  /*
  options:
    sessionId (recording session; only finalized messages carry it)
    recognitionStartTimestamp (Unix epoch ms)
    timeStamp (ms since page time origin)
    transcript
    confidence
    alternatives
  */
  addMessage(resultId, options) {
    if (options.transcript.trim().length == 0) {
      return;
    }

    if (this.messages.some((message) => message.resultId === resultId)) {
      this.messages = this.messages.map((message) => {
        if (message.resultId === resultId) {
          const timeStamp = message.timeStamp || options.timeStamp;
          return {
            resultId: resultId,
            sessionId: options.sessionId,
            recognitionStartTimestamp: options.recognitionStartTimestamp,
            timeStamp,
            transcript: options.transcript,
            confidence: options.confidence,
            alternatives: options.alternatives,
          };
        }
        return message;
      });
    } else {
      this.messages.push({
        resultId: resultId,
        sessionId: options.sessionId,
        recognitionStartTimestamp: options.recognitionStartTimestamp,
        timeStamp: options.timeStamp,
        transcript: options.transcript,
        confidence: options.confidence,
        alternatives: options.alternatives,
      });
    }

    this.updateMessages();
  }

  getFullData(sessionId) {
    return this.messages
      .filter((message) => message.sessionId === sessionId)
      .map((message) => ({
        timeStamp: Math.floor(message.timeStamp / 1000),
        transcript: message.transcript,
      }));
  }

  removeMessage(resultId) {
    this.messages = this.messages.filter(
      (message) => message.resultId !== resultId
    );

    this.updateMessages();
  }

  updateMessages() {
    while (this.target.lastElementChild != null) {
      this.target.removeChild(this.target.lastElementChild);
    }
    for (const message of this.messages) {
      const sec = Math.floor(message.timeStamp / 1000);
      const unixtime = Math.floor(
        (message.recognitionStartTimestamp + message.timeStamp) / 1000
      );
      const transcript = message.transcript;
      const alternatives = message.alternatives;

      const messageLine = document.createElement("div");
      messageLine.classList.add("message-line");
      messageLine.dataset.resultId = message.resultId;

      const messageDate = document.createElement("span");
      messageDate.classList.add("message-sec");
      if (this.isDisplayTimestamp) {
        messageDate.textContent = this.formatDateTime(unixtime);
      } else {
        messageDate.textContent = sec + "s";
      }
      messageDate.dataset.sec = sec;
      messageDate.dataset.unixtime = unixtime;
      messageLine.appendChild(messageDate);

      const percentElem = document.createElement("span");
      percentElem.classList.add("message-percent");
      percentElem.textContent = Math.round(message.confidence * 100) + "%";
      messageLine.appendChild(percentElem);

      const messageText = document.createElement("span");
      messageText.classList.add("message-text");
      messageText.textContent = transcript.trim();
      messageLine.appendChild(messageText);

      const altMessages = document.createElement("ul");
      altMessages.classList.add("alt-messages");

      for (const alt of Array.from(alternatives || []).slice(1)) {
        const altMessage = document.createElement("li");
        const altMessagePercent = document.createElement("span");
        altMessagePercent.textContent = Math.round(alt.confidence * 100) + "%";

        const altMessageText = document.createElement("span");
        altMessageText.classList.add("alt-message-text");

        const fragment = document.createDocumentFragment();
        const diff = JsDiff["diffChars"](transcript, alt.transcript);
        for (let i = 0; i < diff.length; i++) {
          if (diff[i].added && diff[i + 1] && diff[i + 1].removed) {
            const swap = diff[i];
            diff[i] = diff[i + 1];
            diff[i + 1] = swap;
          }

          let node;
          if (diff[i].removed) {
            node = document.createElement("del");
            node.appendChild(document.createTextNode(diff[i].value));
          } else if (diff[i].added) {
            node = document.createElement("ins");
            node.appendChild(document.createTextNode(diff[i].value));
          } else {
            node = document.createTextNode(diff[i].value);
          }
          fragment.appendChild(node);
        }
        altMessage.textContent = "";
        altMessage.appendChild(altMessagePercent);
        altMessageText.appendChild(fragment);
        altMessage.appendChild(altMessageText);
        altMessages.appendChild(altMessage);
      }

      messageLine.appendChild(altMessages);

      this.target.appendChild(messageLine);
    }

    this.target.scrollTop = this.target.scrollHeight;
  }

  setDisplayTimestamp(isDisplayTimestamp) {
    this.isDisplayTimestamp = isDisplayTimestamp;
    this.updateMessages();
  }

  getMessages() {
    return this.messages;
  }

  deleteAllMessages() {
    this.messages = [];
  }

  formatDateTime(unixtime) {
    // yyyy-MM-dd hh:mm:ss
    const date = new Date(unixtime * 1000);
    const year = date.getFullYear();
    const month = ("0" + (date.getMonth() + 1).toString()).slice(-2);
    const day = ("0" + date.getDate().toString()).slice(-2);
    const hours = ("0" + date.getHours().toString()).slice(-2);
    const minutes = ("0" + date.getMinutes().toString()).slice(-2);
    const seconds = ("0" + date.getSeconds().toString()).slice(-2);
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
}

let uploadQueue = Promise.resolve();

function sendResult(session, timeStamp, transcript, fullData) {
  const apiurl = document.getElementById("api_url").value;
  if (apiurl == "") {
    return;
  }
  const snapshot = {
    startTime: session.startTime,
    revision: ++session.revision,
    timeStamp: timeStamp,
    transcript: transcript,
    full: fullData,
  };
  uploadQueue = uploadQueue
    .then(() => axios.post(apiurl, snapshot))
    .then(function (response) {
      if (response.status != 200) {
        console.error(response);
      }
    })
    .catch(function (error) {
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
  axios
    .head(apiurl)
    .then(function (response) {
      console.log("API active.");
    })
    .catch(function (error) {
      if (error.response) {
        console.error("API failed[RESPONSE]: " + error.response.status);
        console.error(error.response);
        if (
          confirm(
            "The API is not working properly(" +
              error.response.status +
              "). Close this page?"
          )
        ) {
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
        if (
          confirm(
            "The API is not working properly(" +
              error.message +
              "). Close this page?"
          )
        ) {
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
    console.log(
      "Fullscreen mode: " + (screenfull.isFullscreen ? "enabled" : "disabled")
    );
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
  return (
    document.fullscreenElement ||
    document.mozFullScreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement
  );
}

started = false;
listening = new Listening();
onload();

function onload() {
  const apiurl = localStorage.getItem("audio-transcriber-web-api-url");
  if (apiurl != null) {
    document.getElementById("api_url").value = apiurl;
  }
  const timestampDisplay = localStorage.getItem(
    "audio-transcriber-web-timestamp-display"
  );
  if (timestampDisplay != null) {
    document.getElementById("timestamp-display").checked =
      timestampDisplay.toLowerCase() === "true";
  }
  const autoStart = localStorage.getItem("audio-transcriber-web-auto-start");
  if (autoStart != null) {
    document.getElementById("auto-start").checked =
      autoStart.toLowerCase() === "true";
  }
  if (document.getElementById("auto-start").checked) {
    started = true;
    start_recognition(0, newSession());
  }

  setInterval(checkAPIURL, 10000);
}

document.getElementById("api_url").onchange = function () {
  localStorage.setItem(
    "audio-transcriber-web-api-url",
    document.getElementById("api_url").value
  );
};

document.getElementById("auto-start").onchange = function () {
  localStorage.setItem(
    "audio-transcriber-web-auto-start",
    document.getElementById("auto-start").checked.toString()
  );
};

document.getElementById("timestamp-display").onchange = function () {
  localStorage.setItem(
    "audio-transcriber-web-timestamp-display",
    document.getElementById("timestamp-display").checked.toString()
  );
};

document.getElementById("startstop").onclick = function () {
  if (!started) {
    started = true;
    start_recognition(0, newSession());
  } else {
    stop_recognition();
  }
};

document.getElementById("fullscreen").onclick = function () {
  if (!screenfull.isFullscreen) {
    startFullScreen();
  } else {
    stopFullScreen();
  }
};

document.getElementById("timestamp-display").onclick = function () {
  if (listening != null) {
    listening
      .getMessagesManager()
      .setDisplayTimestamp(!listening.getMessagesManager().isDisplayTimestamp);
    listening
      .getListeningMessagesManager()
      .setDisplayTimestamp(
        !listening.getListeningMessagesManager().isDisplayTimestamp
      );
  }
};
