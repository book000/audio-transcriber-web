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
