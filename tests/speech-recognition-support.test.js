const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath =
  process.argv[2] ?? path.join(__dirname, "..", "static", "script.js");
const source = fs.readFileSync(scriptPath, "utf8");

const UNSUPPORTED_MESSAGE =
  "Speech recognition is not supported in this browser.";
const ELEMENT_IDS = [
  "startstop",
  "status-message",
  "status-circle",
  "api_url",
  "auto-start",
  "timestamp-display",
  "fullscreen",
  "listening",
  "messages",
];

/**
 * Creates a fake recognition class that records constructions and start calls.
 * @returns {{ Fake: Function, instances: object[], startCalls: number[] }}
 */
function createFakeRecognition() {
  const instances = [];
  const startCalls = [];
  class Fake {
    constructor() {
      instances.push(this);
    }

    start() {
      startCalls.push(instances.indexOf(this));
    }

    stop() {
      this.stopped = true;
    }

    abort() {
      this.aborted = true;
    }
  }
  return { Fake, instances, startCalls };
}

/**
 * Creates a DOM element stub with the properties script.js touches.
 * @param {string} id - Element id
 * @param {boolean} checked - Initial value of the checked property
 * @returns {object} Element stub
 */
function createElement(id, checked) {
  return {
    innerHTML: id === "startstop" ? "Start recording" : "",
    textContent: "",
    checked,
    value: "",
    style: {},
    dataset: {},
    lastElementChild: null,
  };
}

/**
 * Creates a sandbox exposing only the browser globals named by the case.
 * @param {object} options - Sandbox options
 * @param {object} [options.globals] - Extra globals such as SpeechRecognition
 * @param {boolean} [options.autoStart] - Whether auto-start is checked
 * @returns {{ sandbox: object, elements: Record<string, object> }}
 */
function createSandbox({ globals = {}, autoStart = false }) {
  const elements = {};
  for (const id of ELEMENT_IDS) {
    elements[id] = createElement(id, id === "auto-start" && autoStart);
  }
  const timers = new Map();
  let timerId = 0;
  const sandbox = {
    ...globals,
    document: { getElementById: (id) => elements[id] },
    localStorage: { getItem: () => null },
    setInterval: () => 0,
    setTimeout: (callback, delay) => {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  function runNextTimer() {
    assert.equal(timers.size, 1);
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.callback();
    return timer.delay;
  }
  return { sandbox, elements, timers, runNextTimer };
}

/**
 * Runs a function and returns the error it threw, or null.
 * @param {Function} fn - Function to run
 * @returns {Error|null} The thrown error, or null if none
 */
function catchError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Loads script.js into the sandbox and clicks the start/stop button.
 * @param {object} options - Same options as createSandbox
 * @returns {object} Sandbox, elements, and the load and click errors
 */
function loadAndClick(options) {
  const { sandbox, elements } = createSandbox(options);
  const loadError = catchError(() => vm.runInContext(source, sandbox));
  const clickError = catchError(() => elements.startstop.onclick());
  return { sandbox, elements, loadError, clickError };
}

/**
 * Loads script.js with a recording POST stub and a controllable clock.
 * @returns {{ elements: object, instances: object[], posts: object[], clock: { now: number }, sandbox: object }}
 */
function createRecordingHarness({ autoStart = false } = {}) {
  const standard = createFakeRecognition();
  const { sandbox, elements, timers, runNextTimer } = createSandbox({
    globals: { SpeechRecognition: standard.Fake },
    autoStart,
  });
  const posts = [];
  sandbox.axios = {
    post: (url, body) => {
      posts.push({ url, body });
      return Promise.resolve({ status: 200 });
    },
  };
  const clock = { now: 1000000 };
  sandbox.Date = class FakeDate {
    constructor() {
      this.ms = clock.now;
    }

    getTime() {
      return this.ms;
    }
  };
  sandbox.document.createElement = () => ({
    classList: { add() {} },
    dataset: {},
    appendChild() {},
  });
  elements.listening.appendChild = () => {};
  elements.messages.appendChild = () => {};
  elements.api_url.value = "http://localhost:8080/api";
  vm.runInContext(source, sandbox);
  return {
    elements,
    instances: standard.instances,
    posts,
    clock,
    sandbox,
    timers,
    runNextTimer,
  };
}

function finalResult(transcript) {
  return { isFinal: true, length: 1, 0: { transcript, confidence: 0.9 } };
}

function summarizePosts(posts) {
  return JSON.parse(
    JSON.stringify(
      posts.map(({ body }) => ({
        startTime: body.startTime,
        transcript: body.transcript,
        full: body.full,
      }))
    )
  );
}

function recordStopStart() {
  const harness = createRecordingHarness();
  const { elements, instances, clock } = harness;
  const results = {
    one: finalResult("one"),
    two: finalResult("two"),
    newOne: finalResult("new one"),
  };
  elements.startstop.onclick();
  instances[0].onresult({
    resultIndex: 0,
    timeStamp: 1500,
    results: [results.one],
  });
  instances[0].onresult({
    resultIndex: 1,
    timeStamp: 3200,
    results: [results.one, results.two],
  });
  elements.startstop.onclick();
  clock.now = 2000000;
  elements.startstop.onclick();
  instances[1].onresult({
    resultIndex: 0,
    timeStamp: 1500,
    results: [results.newOne],
  });
  return { ...harness, results };
}

const cases = [
  ...[
    "not-allowed",
    "service-not-allowed",
    "audio-capture",
    "aborted",
    "language-not-supported",
    "phrases-not-supported",
    "bad-grammar",
    "unknown-error",
  ].map((error) => [
    `${error} stops recording without retrying and allows a manual restart`,
    () => {
      const { elements, instances, sandbox, timers } = createRecordingHarness();
      elements.startstop.onclick();
      const recognition = instances[0];
      recognition.onstart({ timeStamp: 0 });
      recognition.onresult({
        resultIndex: 0,
        timeStamp: 1000,
        results: [
          finalResult("saved"),
          { ...finalResult("unfinished"), isFinal: false },
        ],
      });
      recognition.onerror({ error });
      assert.equal(sandbox.started, false);
      assert.equal(vm.runInContext("currentRecognition", sandbox), null);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.equal(elements["status-circle"].style.backgroundColor, "red");
      assert.equal(elements["status-message"].textContent, error);
      assert.equal(recognition.aborted, true);
      assert.equal(sandbox.listening.getMessagesManager().getMessages().length, 1);
      assert.equal(
        sandbox.listening.getListeningMessagesManager().getMessages().length,
        0
      );
      recognition.onend({});
      assert.equal(instances.length, 1);
      assert.equal(timers.size, 0);
      elements.startstop.onclick();
      instances[1].onstart({ timeStamp: 2000 });
      assert.equal(sandbox.started, true);
      assert.equal(elements.startstop.innerHTML, "Stop recording");
      assert.equal(elements["status-message"].textContent, "");
    },
  ]),
  ...["network", "no-speech", null].map((error) => [
    `${error || "empty end"} retries three times with backoff, then stops`,
    () => {
      const { elements, instances, sandbox, timers, runNextTimer } =
        createRecordingHarness();
      elements.startstop.onclick();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const recognition = instances[attempt];
        recognition.onstart({ timeStamp: attempt * 1000 });
        if (error !== null) {
          recognition.onerror({ error });
          assert.equal(timers.size, 0);
        }
        recognition.onend({});
        recognition.onend({});
        assert.equal(instances.length, attempt + 1);
        if (attempt < 3) {
          assert.equal(sandbox.started, true);
          assert.equal(runNextTimer(), 1000 * 2 ** attempt);
          assert.equal(instances.length, attempt + 2);
        }
      }
      assert.equal(timers.size, 0);
      assert.equal(sandbox.started, false);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.equal(elements["status-circle"].style.backgroundColor, "red");
      assert.match(elements["status-message"].textContent, /retries exhausted/);
      elements.startstop.onclick();
      instances[4].onerror({ error: "network" });
      instances[4].onend({});
      assert.equal(runNextTimer(), 1000);
    },
  ]),
  [
    "late interim results after stop cannot reappear or alter a new recording",
    () => {
      const { elements, instances, sandbox } = createRecordingHarness();
      elements.startstop.onclick();
      const oldRecognition = instances[0];
      const interimEvent = {
        resultIndex: 0,
        timeStamp: 1000,
        results: [{ ...finalResult("obsolete speech"), isFinal: false }],
      };
      oldRecognition.onresult(interimEvent);
      elements.startstop.onclick();
      oldRecognition.onresult(interimEvent);
      assert.equal(
        sandbox.listening.getListeningMessagesManager().getMessages().length,
        0
      );
      oldRecognition.onend({});
      elements.startstop.onclick();
      instances[1].onresult({
        ...interimEvent,
        results: [{ ...finalResult("current speech"), isFinal: false }],
      });
      oldRecognition.onresult(interimEvent);
      oldRecognition.onend({});
      const messages = sandbox.listening.getListeningMessagesManager().getMessages();
      assert.equal(messages.length, 1);
      assert.equal(messages[0].transcript, "current speech");
    },
  ],
  [
    "manual stop releases the recognizer and ignores its late error and end",
    () => {
      const { elements, instances, sandbox, timers } = createRecordingHarness();
      elements.startstop.onclick();
      const oldRecognition = instances[0];
      elements.startstop.onclick();
      assert.equal(oldRecognition.stopped, true);
      assert.equal(sandbox.started, false);
      assert.equal(elements["status-circle"].style.backgroundColor, "red");
      elements.startstop.onclick();
      instances[1].onstart({ timeStamp: 1000 });
      oldRecognition.onerror({ error: "aborted" });
      oldRecognition.onend({});
      assert.equal(sandbox.started, true);
      assert.equal(instances.length, 2);
      assert.equal(elements["status-message"].textContent, "");
      assert.equal(elements["status-circle"].style.backgroundColor, "cyan");
      assert.equal(timers.size, 0);
    },
  ],
  [
    "stop cancels a pending retry and a new recording ignores obsolete lifecycle events",
    () => {
      const { elements, instances, sandbox, timers } = createRecordingHarness();
      elements.startstop.onclick();
      const oldRecognition = instances[0];
      oldRecognition.onerror({ error: "network" });
      oldRecognition.onend({});
      assert.equal(timers.size, 1);
      elements.startstop.onclick();
      assert.equal(timers.size, 0);
      assert.equal(sandbox.started, false);
      elements.startstop.onclick();
      instances[1].onstart({ timeStamp: 1000 });
      instances[1].onresult({
        resultIndex: 0,
        timeStamp: 1500,
        results: [{ ...finalResult("current speech"), isFinal: false }],
      });
      oldRecognition.onerror({ error: "not-allowed" });
      oldRecognition.onend({});
      oldRecognition.onstart({ timeStamp: 0 });
      oldRecognition.onaudiostart({});
      oldRecognition.onaudioend({});
      oldRecognition.onspeechstart({});
      oldRecognition.onspeechend({});
      assert.equal(instances.length, 2);
      assert.equal(timers.size, 0);
      assert.equal(sandbox.started, true);
      assert.equal(elements.startstop.innerHTML, "Stop recording");
      assert.equal(elements["status-circle"].style.backgroundColor, "cyan");
      assert.equal(elements["status-message"].textContent, "");
      assert.equal(
        sandbox.listening.getListeningMessagesManager().getMessages().length,
        1
      );
    },
  ],
  [
    "a non-empty final transcript resets the retry budget and keeps the upload session",
    async () => {
      const { elements, instances, posts, sandbox, runNextTimer } =
        createRecordingHarness();
      elements.startstop.onclick();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        instances[attempt].onerror({ error: "network" });
        instances[attempt].onend({});
        assert.equal(runNextTimer(), 1000 * 2 ** attempt);
      }
      instances[2].onresult({
        resultIndex: 0,
        timeStamp: 1500,
        results: [finalResult("recovered")],
      });
      instances[2].onerror({ error: "network" });
      instances[2].onend({});
      assert.equal(runNextTimer(), 1000);
      instances[3].onresult({
        resultIndex: 0,
        timeStamp: 2500,
        results: [finalResult("still recording")],
      });
      await vm.runInContext("uploadQueue", sandbox);
      assert.deepEqual(posts.map(({ body }) => body.startTime), [1000, 1000]);
      assert.deepEqual(posts.map(({ body }) => body.revision), [1, 2]);
      assert.equal(posts[1].body.full.length, 2);
    },
  ],
  [
    "interim and empty final results do not reset the retry limit",
    () => {
      const { elements, instances, sandbox, runNextTimer } =
        createRecordingHarness();
      elements.startstop.onclick();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        instances[attempt].onresult({
          resultIndex: 0,
          timeStamp: 1000,
          results: [
            { ...finalResult("unfinished"), isFinal: false },
            finalResult("  "),
          ],
        });
        instances[attempt].onend({});
        if (attempt < 3) {
          runNextTimer();
        }
      }
      assert.equal(sandbox.started, false);
      assert.equal(instances.length, 4);
    },
  ],
  [
    "an auto-start permission error stops until the user starts again",
    () => {
      const { elements, instances, sandbox, timers } = createRecordingHarness({
        autoStart: true,
      });
      instances[0].onerror({ error: "not-allowed" });
      instances[0].onend({});
      assert.equal(sandbox.started, false);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.equal(timers.size, 0);
      assert.equal(instances.length, 1);
    },
  ],
  [
    "a synchronous start failure stops recording without retrying",
    () => {
      const standard = createFakeRecognition();
      standard.Fake.prototype.start = () => {
        throw new Error("Microphone unavailable");
      };
      const { sandbox, elements, loadError, clickError } = loadAndClick({
        globals: { SpeechRecognition: standard.Fake },
      });
      assert.equal(loadError, null);
      assert.equal(clickError, null);
      assert.equal(sandbox.started, false);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.match(elements["status-message"].textContent, /Microphone unavailable/);
      assert.equal(standard.instances[0].aborted, true);
      standard.instances[0].onend({});
      assert.equal(standard.instances.length, 1);
    },
  ],
  [
    "standard SpeechRecognition only",
    () => {
      const standard = createFakeRecognition();
      const { elements, loadError, clickError } = loadAndClick({
        globals: { SpeechRecognition: standard.Fake },
      });
      assert.equal(loadError, null);
      assert.equal(clickError, null);
      assert.equal(standard.instances.length, 1);
      assert.deepEqual(standard.startCalls, [0]);
      assert.equal(elements.startstop.innerHTML, "Stop recording");
    },
  ],
  [
    "webkitSpeechRecognition only",
    () => {
      const webkit = createFakeRecognition();
      const { elements, loadError, clickError } = loadAndClick({
        globals: { webkitSpeechRecognition: webkit.Fake },
      });
      assert.equal(loadError, null);
      assert.equal(clickError, null);
      assert.equal(webkit.instances.length, 1);
      assert.deepEqual(webkit.startCalls, [0]);
      assert.equal(elements.startstop.innerHTML, "Stop recording");
    },
  ],
  [
    "both standard and webkit (standard is preferred)",
    () => {
      const standard = createFakeRecognition();
      const webkit = createFakeRecognition();
      const { loadError, clickError } = loadAndClick({
        globals: {
          SpeechRecognition: standard.Fake,
          webkitSpeechRecognition: webkit.Fake,
        },
      });
      assert.equal(loadError, null);
      assert.equal(clickError, null);
      assert.equal(standard.instances.length, 1);
      assert.deepEqual(standard.startCalls, [0]);
      assert.equal(webkit.instances.length, 0);
    },
  ],
  [
    "neither implementation (shows an error and does not throw)",
    () => {
      const { sandbox, elements, loadError, clickError } = loadAndClick({});
      assert.equal(loadError, null);
      assert.equal(clickError, null);
      assert.equal(elements["status-message"].textContent, UNSUPPORTED_MESSAGE);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.equal(sandbox.started, false);

      const secondClickError = catchError(() => elements.startstop.onclick());
      assert.equal(secondClickError, null);
      assert.equal(elements["status-message"].textContent, UNSUPPORTED_MESSAGE);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.equal(sandbox.started, false);
    },
  ],
  [
    "neither implementation with auto-start checked",
    () => {
      const { sandbox, elements } = createSandbox({ autoStart: true });
      const loadError = catchError(() => vm.runInContext(source, sandbox));
      assert.equal(loadError, null);
      assert.equal(elements["status-message"].textContent, UNSUPPORTED_MESSAGE);
      assert.equal(elements.startstop.innerHTML, "Start recording");
      assert.equal(sandbox.started, false);
      assert.equal(typeof elements.startstop.onclick, "function");
    },
  ],
  [
    "POST sends every finalized transcript once in full, without duplicates",
    async () => {
      const standard = createFakeRecognition();
      const { sandbox, elements } = createSandbox({
        globals: { SpeechRecognition: standard.Fake },
      });
      const posts = [];
      sandbox.axios = {
        post: (url, body) => {
          posts.push({ url, body });
          return Promise.resolve({ status: 200 });
        },
      };
      const createStub = () => ({
        classList: { add() {} },
        dataset: {},
        appendChild() {},
      });
      sandbox.document.createElement = createStub;
      elements.listening.appendChild = () => {};
      elements.messages.appendChild = () => {};
      elements.api_url.value = "http://localhost:8080/api";
      vm.runInContext(source, sandbox);
      elements.startstop.onclick();

      const result = (transcript) => ({
        isFinal: true,
        length: 1,
        0: { transcript, confidence: 0.9 },
      });
      const first = result("hello");
      const second = result("world");
      const recognition = standard.instances[0];
      recognition.onresult({ resultIndex: 0, timeStamp: 1500, results: [first] });
      recognition.onresult({
        resultIndex: 1,
        timeStamp: 3200,
        results: [first, second],
      });

      await vm.runInContext("uploadQueue", sandbox);
      const hello = { timeStamp: 1, transcript: "hello" };
      const world = { timeStamp: 3, transcript: "world" };
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(
            posts.map((post) => [
              post.body.timeStamp,
              post.body.transcript,
              post.body.full,
            ])
          )
        ),
        [
          [1, "hello", [hello]],
          [3, "world", [hello, world]],
        ]
      );
    },
  ],
  [
    "a second recording uploads only its own transcripts under its own startTime",
    async () => {
      const { posts, sandbox } = recordStopStart();
      await vm.runInContext("uploadQueue", sandbox);
      const summary = summarizePosts(posts);
      assert.equal(posts[posts.length - 1].body.revision, 1);
      assert.deepEqual(summary[summary.length - 1], {
        startTime: 2000,
        transcript: "new one",
        full: [{ timeStamp: 1, transcript: "new one" }],
      });
      assert.deepEqual(
        summary.filter((post) => post.startTime === 2000).length,
        1
      );
    },
  ],
  [
    "a late result from the old recording keeps the old startTime and full",
    async () => {
      const { posts, instances, results, sandbox } = recordStopStart();
      const late = finalResult("late");
      instances[0].onresult({
        resultIndex: 2,
        timeStamp: 5000,
        results: [results.one, results.two, late],
      });
      await vm.runInContext("uploadQueue", sandbox);
      const summary = summarizePosts(posts);
      assert.deepEqual(summary[summary.length - 1], {
        startTime: 1000,
        transcript: "late",
        full: [
          { timeStamp: 1, transcript: "one" },
          { timeStamp: 3, transcript: "two" },
          { timeStamp: 5, transcript: "late" },
        ],
      });
    },
  ],
  [
    "an onend restart within one recording keeps the session and earlier results",
    async () => {
      const { elements, instances, posts, sandbox } = createRecordingHarness();
      elements.startstop.onclick();
      instances[0].onresult({
        resultIndex: 0,
        timeStamp: 1500,
        results: [finalResult("one")],
      });
      instances[0].onend({});
      instances[1].onresult({
        resultIndex: 0,
        timeStamp: 3200,
        results: [finalResult("new one")],
      });
      await vm.runInContext("uploadQueue", sandbox);
      const summary = summarizePosts(posts);
      assert.deepEqual(summary[summary.length - 1], {
        startTime: 1000,
        transcript: "new one",
        full: [
          { timeStamp: 1, transcript: "one" },
          { timeStamp: 3, transcript: "new one" },
        ],
      });
    },
  ],
  [
    "interim updates do not re-upload finals and a batch uploads each new final once",
    async () => {
      const { elements, instances, posts, sandbox } = createRecordingHarness();
      elements.startstop.onclick();
      const recognition = instances[0];
      const first = finalResult("one");
      const interim = { ...finalResult("unfinished"), isFinal: false };
      recognition.onresult({
        resultIndex: 0,
        timeStamp: 1000,
        results: [first, interim],
      });
      recognition.onresult({
        resultIndex: 1,
        timeStamp: 2000,
        results: [first, interim],
      });
      await vm.runInContext("uploadQueue", sandbox);
      assert.equal(posts.length, 1);
      assert.equal(
        sandbox.listening.getListeningMessagesManager().getMessages().length,
        1
      );
      recognition.onresult({
        resultIndex: 1,
        timeStamp: 3000,
        results: [first, finalResult("two"), finalResult("three")],
      });
      await vm.runInContext("uploadQueue", sandbox);
      assert.deepEqual(posts.map(({ body }) => body.revision), [1, 2, 3]);
      assert.deepEqual(
        posts.map(({ body }) => body.transcript),
        ["one", "two", "three"]
      );
      assert.equal(posts[2].body.full.length, 3);
      assert.equal(
        sandbox.listening.getListeningMessagesManager().getMessages().length,
        0
      );
    },
  ],
  [
    "uploads wait for the preceding request and continue after rejection",
    async () => {
      const { elements, instances, posts, sandbox } = createRecordingHarness();
      let rejectFirst;
      sandbox.axios.post = (url, body) => {
        posts.push({ url, body });
        if (posts.length === 1) {
          return new Promise((resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve({ status: 200 });
      };
      elements.startstop.onclick();
      const first = finalResult("one");
      instances[0].onresult({ resultIndex: 0, timeStamp: 1500, results: [first] });
      instances[0].onresult({
        resultIndex: 1,
        timeStamp: 3200,
        results: [first, finalResult("two")],
      });
      await Promise.resolve();
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.revision, 1);
      rejectFirst(new Error("Simulated upload failure"));
      await vm.runInContext("uploadQueue", sandbox);
      assert.equal(posts.length, 2);
      assert.equal(posts[1].body.revision, 2);
      assert.equal(posts[0].body.full.length, 1);
      assert.equal(posts[1].body.full.length, 2);
    },
  ],
  [
    "earlier recordings stay on the page with distinct result IDs",
    () => {
      const { sandbox } = recordStopStart();
      const resultIds = sandbox.listening
        .getMessagesManager()
        .getMessages()
        .map((message) => message.resultId);
      assert.deepEqual(JSON.parse(JSON.stringify(resultIds)), [
        "1-0-0",
        "1-0-1",
        "2-0-0",
      ]);
    },
  ],
];

async function main() {
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.log(`not ok - ${name}: ${error.stack}`);
      process.exitCode = 1;
    }
  }
}

main();
