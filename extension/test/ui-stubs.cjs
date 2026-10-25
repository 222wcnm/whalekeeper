'use strict';
// Zero-dependency browser/clock doubles: these tests never start Chrome or a server.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Clock {
  now = 100000;
  nextId = 1;
  tasks = new Map();
  set = (fn, ms, interval = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + ms, interval });
    return id;
  };
  clear = (id) => { this.tasks.delete(id); };
  async advance(ms) {
    const until = this.now + ms;
    for (;;) {
      let next;
      for (const [id, task] of this.tasks) {
        if (task.at <= until && (!next || task.at < next[1].at)) next = [id, task];
      }
      if (!next) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.interval) task.at += task.interval;
      else this.tasks.delete(id);
      task.fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.className = '';
    this._text = '';
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList.contains(name) : force;
        if (on) this.classList.add(name); else this.classList.remove(name);
        return on;
      },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child, before) {
    child.parentElement = this;
    const at = this.children.indexOf(before);
    this.children.splice(at < 0 ? 0 : at, 0, child);
    return child;
  }
  get firstChild() { return this.children[0]; }
  attachShadow() { this.shadowRoot = new Element('shadow-root'); return this.shadowRoot; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, event = {}) {
    event.target ??= this;
    event.stopPropagation ??= () => {};
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
  matches(selector) {
    if (selector[0] === '#') return this.id === selector.slice(1);
    if (selector[0] === '.') return this.classList.contains(selector.slice(1));
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(part => part.trim());
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selectors.some(sel => child.matches(sel))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    if (selector.split(',').some(sel => this.matches(sel.trim()))) return this;
    return this.parentElement?.closest(selector) || null;
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
}
function response(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}
function environment(options = {}) {
  const clock = new Clock();
  const document = new Element('document');
  document.title = options.title ?? 'DeepSeek Harness';
  document.hidden = options.hidden ?? false;
  document.readyState = 'loading'; // Popup init is driven explicitly, never implicitly by the VM.
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.appendChild(document.documentElement);
  document.documentElement.appendChild(document.body);
  const byId = new Map();
  document.getElementById = (id) => document.querySelector('#' + id) || byId.get(id) || null;
  document.createElement = (tag) => new Element(tag);
  const scans = [];
  const queryAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => { scans.push(selector); return queryAll(selector); };
  const window = new Element('window');
  const location = new URL(options.url ?? 'http://127.0.0.1:3080/');
  window.location = location;
  const messages = [];
  const storage = {};
  const listeners = [];
  const calls = [];
  const fetches = [];
  const sources = [];
  class EventSource {
    constructor(url) { this.url = url; this.events = new Map(); this.closed = false; sources.push(this); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    open() { this.onopen?.(); }
    event(name, data) { this.events.get(name)?.({ data: JSON.stringify(data) }); }
    error() { this.onerror?.(); }
    close() { this.closed = true; }
  }
  const chrome = {
    runtime: {
      id: 'own-extension-id',
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage: async (message) => {
        messages.push(JSON.parse(JSON.stringify(message)));
        if (options.sendMessage) return options.sendMessage(message);
        return { ok: true, result: { state: 'running', port: Number(location.port || 80) } };
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(defaults, callback) { const value = { ...defaults, ...storage }; if (callback) callback(value); return Promise.resolve(value); },
        set(value, callback) { Object.assign(storage, JSON.parse(JSON.stringify(value))); callback?.(); return Promise.resolve(); },
      },
    },
    tabs: {
      query: async () => options.tabs || [],
      sendMessage: async (id, message, sendOptions) => {
        calls.push({ action: 'auth', id, message, sendOptions });
        if (options.auth) return options.auth(id, message);
        return { authenticated: true, port: Number(location.port || 80) };
      },
      update: async (id, opts) => { calls.push({ action: 'update', id, ...opts }); },
      create: async (opts) => { calls.push({ action: 'create', ...opts }); },
      reload: async (id) => { calls.push({ action: 'reload', id }); },
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      update: async (id, opts) => { calls.push({ action: 'window', id, ...opts }); },
    },
  };
  class MockDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({
    URL, URLSearchParams, console, AbortController, Promise, Date: MockDate,
    performance: { now: () => clock.now }, document, window, location, chrome, EventSource,
    MutationObserver: class { observe() {} disconnect() {} },
    DSHColors: { DEFAULT_COLOR_MAP: {}, normalizeColorMap: value => value },
    DSHTheme: {},
    setTimeout: (fn, ms) => clock.set(fn, ms), clearTimeout: clock.clear,
    setInterval: (fn, ms) => clock.set(fn, ms, ms), clearInterval: clock.clear,
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      if (options.fetch) return options.fetch(url, opts);
      return response(404, null);
    },
  });
  function run(source) { return vm.runInContext(source, context); }
  function load(file) { return run(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')); }
  function addId(id) { const element = new Element(); element.id = id; byId.set(id, element); return element; }
  return { clock, document, window, messages, listeners, calls, fetches, scans, sources, storage, context, load, run, addId };
}
module.exports = { environment, flush, deferred, response };
