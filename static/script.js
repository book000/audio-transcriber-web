function start_recognition(recognitionId) {
  document.getElementById("startstop").innerHTML = "Stop recording";
  const SpeechRecognition = webkitSpeechRecognition || SpeechRecognition;
  const recognition = new SpeechRecognition();
  if (typeof listening === "undefined") {
    listening = new Listening(recognitionId);
  }
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  recognition.onresult = function (event) {
    console.log(event);
    for (var i = 0; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        listening.end(i, Math.floor(event.timeStamp / 1000), event.results[i]);
      } else {
        listening.runResults(
          i,
          Math.floor(event.timeStamp / 1000),
          event.results[i]
        );
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
    listening.recognitionStartHandler();
  };
  recognition.onaudiostart = function (event) {
    console.log("onaudiostart", event);
    document.getElementById("status-circle").style.backgroundColor =
      "limegreen";
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
    document.getElementById("status-circle").style.backgroundColor =
      "limegreen";
  };
  recognition.onerror = function (event) {
    console.log("onerror", event);
    document.getElementById("status-circle").style.backgroundColor = "red";
    document.getElementById("status-message").innerHTML = event.error;
  };
  recognition.start();
}

class Listening {
  constructor() {
    this.listeningMessagesManager = new MessagesManager(
      document.getElementById("listening")
    );
    this.messagesManager = new MessagesManager(
      document.getElementById("messages")
    );
    this.timeStamp = [];
    this.recognitionStartTimestamp = null;
  }

  recognitionStartHandler() {
    this.recognitionStartTimestamp = new Date().getTime() / 1000;
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

  end(resultId, timeStamp, results) {
    this.listeningMessagesManager.removeMessage(resultId);

    this.messagesManager.addMessage(resultId, {
      recognitionStartTimestamp: this.recognitionStartTimestamp,
      timeStamp: timeStamp,
      transcript: results[0].transcript,
      confidence: results[0].confidence,
      alternatives: Array.from(results),
    });

    sendResult(this.timeStamp, results[0].transcript);
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
    recognitionStartTimestamp
    timeStamp
    transcript
    percent
    alternatives
  */
  addMessage(resultId, options) {
    if (options.transcript.trim().length == 0) {
      return;
    }

    // resultIdがmessagesに存在しない場合は新規作成
    if (this.messages.some((message) => message.resultId === resultId)) {
      // 置き換え
      this.messages = this.messages.map((message) => {
        if (message.resultId === resultId) {
          const timeStamp = message.timeStamp || options.timeStamp;
          return {
            resultId: resultId,
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
      // 新規追加
      this.messages.push({
        resultId: resultId,
        recognitionStartTimestamp: options.recognitionStartTimestamp,
        timeStamp: options.timeStamp,
        transcript: options.transcript,
        confidence: options.confidence,
        alternatives: options.alternatives,
      });
    }

    this.updateMessages();
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
      const sec = message.timeStamp;
      const unixtime = Math.floor(message.recognitionStartTimestamp + sec);
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
      messageText.innerHTML = transcript.trim();
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
    // ゼロ埋め
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

function sendResult(timeStamp, transcript) {
  const apiurl = document.getElementById("api_url").value;
  if (apiurl == "") {
    return;
  }
  axios
    .post(apiurl, {
      startTime: startTime,
      timeStamp: timeStamp,
      transcript: transcript,
      full: fullData,
    })
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
  if (axios != undefined) {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://unpkg.com/axios/dist/axios.min.js";
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
    document.getElementById("auto-start").checked =
      autoStart.toLowerCase() === "true";
  }
  if (document.getElementById("auto-start").checked) {
    started = true;
    startTime = new Date().getTime() / 1000;
    start_recognition(0);
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
