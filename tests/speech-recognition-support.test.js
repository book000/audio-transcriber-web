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

    stop() {}
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
  const sandbox = {
    ...globals,
    document: { getElementById: (id) => elements[id] },
    localStorage: { getItem: () => null },
    setInterval: () => 0,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, elements };
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
function createRecordingHarness() {
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
  return { elements, instances: standard.instances, posts, clock, sandbox };
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
  instances[0].onresult({ timeStamp: 1500, results: [results.one] });
  instances[0].onresult({
    timeStamp: 3200,
    results: [results.one, results.two],
  });
  elements.startstop.onclick();
  clock.now = 2000000;
  elements.startstop.onclick();
  instances[1].onresult({ timeStamp: 1500, results: [results.newOne] });
  return { ...harness, results };
}

const cases = [
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
    () => {
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
      recognition.onresult({ timeStamp: 1500, results: [first] });
      recognition.onresult({ timeStamp: 3200, results: [first, second] });

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
          [3, "hello", [hello]],
          [3, "world", [hello, world]],
        ]
      );
    },
  ],
  [
    "a second recording uploads only its own transcripts under its own startTime",
    () => {
      const { posts } = recordStopStart();
      const summary = summarizePosts(posts);
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
    () => {
      const { posts, instances, results } = recordStopStart();
      const late = finalResult("late");
      instances[0].onresult({
        timeStamp: 5000,
        results: [results.one, results.two, late],
      });
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
    () => {
      const { elements, instances, posts } = createRecordingHarness();
      elements.startstop.onclick();
      instances[0].onresult({ timeStamp: 1500, results: [finalResult("one")] });
      instances[0].onend({});
      instances[1].onresult({
        timeStamp: 3200,
        results: [finalResult("new one")],
      });
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

for (const [name, run] of cases) {
  const error = catchError(run);
  if (error === null) {
    console.log(`ok - ${name}`);
  } else {
    console.log(`not ok - ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}
