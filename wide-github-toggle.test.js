const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

const context = vm.createContext({
  chrome: {runtime: {onMessage: {addListener() {}}, sendMessage() {}}},
  document: {readyState: 'loading', addEventListener() {}},
});
vm.runInContext(fs.readFileSync(`${__dirname}/wide-github-toggle.js`, 'utf8'), context);

test('review categories separate source, tests and other files', () => {
  const cases = [
    ['cmd/main.go', ['all', 'go']],
    ['cmd/main_test.go', ['all', 'go-test', 'test']],
    ['web/app.tsx', ['all', 'frontend']],
    ['web/app.spec.tsx', ['all', 'frontend-test', 'test']],
    ['web/__tests__/App.vue', ['all', 'frontend-test', 'test']],
    ['tests/api.go', ['all', 'go-test', 'test']],
    ['e2e/login.cy.ts', ['all', 'frontend-test', 'test']],
    ['testdata/input.json', ['all', 'test']],
    ['api_test.py', ['all', 'test']],
    ['web/style.scss', ['all', 'frontend']],
    ['web/config.mjs', ['all', 'frontend']],
    ['web/widget.svelte', ['all', 'frontend']],
    ['web/latest.ts', ['all', 'frontend']],
    ['docs/spec.md', ['all', 'markdown']],
    ['docs/design.md', ['all', 'markdown']],
    ['docs/component.mdx', ['all', 'markdown']],
    ['src/main.rs', ['all', 'rust']],
    ['tests/api.rs', ['all', 'rust', 'test']],
    ['go.mod', ['all', 'other']],
    ['', ['all']],
  ];
  const categories = ['all', 'markdown', 'rust', 'generated', 'go', 'frontend', 'go-test', 'frontend-test', 'test', 'other'];
  for (const [path, expected] of cases) {
    assert.deepEqual(categories.filter((category) => context.matchesFileCategory(path, category)),
      expected, path);
  }
  assert.equal(context.matchesFileCategory('cmd/main.go', 'unknown'), false);
});

test('generated files are separate from source and test categories', () => {
  for (const path of ['src/generated.go', 'mock_test.go', 'client.ts', 'README.md', 'bindings.rs']) {
    assert.equal(context.matchesFileCategory(path, 'generated', true), true);
    assert.equal(context.matchesFileCategory(path, 'all', true), true);
    for (const category of ['go', 'go-test', 'frontend', 'frontend-test', 'rust', 'markdown', 'test', 'other']) {
      assert.equal(context.matchesFileCategory(path, category, true), false, `${path}: ${category}`);
    }
    assert.equal(context.matchesFileCategory(path, 'generated', false), false);
  }
});

test('GitHub generated notice is remembered after Load Diff removes it', () => {
  let showNotice = true;
  const file = {
    closest: () => file,
    matches: () => false,
    getAttribute: (name) => name === 'data-file-path' ? 'mock/generated.go' : null,
    querySelector: (selector) => selector === '[data-diff-anchor] .fgColor-muted' && showNotice
      ? {textContent: 'Some generated files are not rendered by default. Learn more about customizing how changed files appear on GitHub.'}
      : null,
  };
  assert.equal(context.isGeneratedFile(file), true);
  showNotice = false;
  assert.equal(context.isGeneratedFile(file), true);
  file.getAttribute = (name) => name === 'data-file-path' ? 'src/main.go' : null;
  assert.equal(context.isGeneratedFile(file), false);
});

test('file paths come from the diff container or its header', () => {
  const attributeNode = (attributes, child = null) => ({
    getAttribute: (name) => attributes[name] || null,
    querySelector: () => child,
  });
  for (const file of [
    attributeNode({'data-path': 'a.go'}),
    attributeNode({'data-file-path': 'a.go'}),
    attributeNode({}, attributeNode({'data-path': 'a.go'})),
    attributeNode({}, attributeNode({title: 'a.go'})),
  ]) {
    assert.equal(context.getFilePath({closest: () => file}), 'a.go');
  }
  assert.equal(context.getFilePath({closest: () => null}), '');
  assert.equal(context.getFilePath({closest: () => attributeNode({})}), '');
});

test('new React diff files expose paths only in the heading link, with direction marks', () => {
  const path = 'src/new_file_lifecycle_test.go';
  const file = {
    getAttribute: () => null,
    querySelector: (selector) => selector === 'h3 a[href^="#diff-"]'
      ? {textContent: `\u200e${path}\u200e`} : null,
  };
  const actual = context.getFilePath({closest: () => file});
  assert.equal(actual, path);
  assert.equal(context.matchesFileCategory(actual, 'go-test'), true);
  assert.equal(context.matchesFileCategory(actual, 'go'), false);
});

function bulkFixture(paths) {
  let now = 0;
  const visits = [];
  const files = new Map();
  const sandbox = vm.createContext({
    chrome: {runtime: {onMessage: {addListener() {}}, sendMessage() {}}},
    document: {readyState: 'loading', addEventListener() {}, querySelector: () => null,
      getElementById: (id) => files.get(id), querySelectorAll: () => []},
    location: {hostname: 'github.com', pathname: '/owner/repo/pull/1/changes', search: ''},
    Date: {now: () => now},
    window: {scrollY: 900, scrollTo: (x, y) => visits.push(y),
      setTimeout(callback, ms) { now += ms; queueMicrotask(callback); }},
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/wide-github-toggle.js`, 'utf8'), sandbox);
  const entries = paths.map((path, i) => {
    const control = {checked: false, clicks: 0, click() { this.clicks++; this.checked = true; }};
    const element = {control, scrollIntoView: () => visits.push(path)};
    const entry = {path, id: `diff-${i}`, element};
    files.set(entry.id, element);
    return entry;
  });
  sandbox.getFileInventory = () => entries;
  sandbox.getActionTargets = (matcher, root) => [root.control];
  sandbox.isGeneratedFile = () => false;
  sandbox.scheduleSyncActionBar = () => {};
  return {sandbox, entries, files, visits, setTime: (value) => { now = value; }, getTime: () => now,
    run: () => sandbox.runBulkAction(sandbox.isViewedToggle, (control) => !control.checked, ['all'])};
}

test('bulk review visits files above the current scroll, verifies delayed state, and reports failures', async () => {
  const fixture = bulkFixture(['already.go', 'delayed.go', 'failed.go']);
  const [already, delayed, failed] = fixture.entries.map((entry) => entry.element.control);
  already.checked = true;
  let readyAt = Infinity;
  Object.defineProperty(delayed, 'checked', {get: () => fixture.getTime() >= readyAt});
  delayed.click = () => { delayed.clicks++; readyAt = fixture.getTime() + 500; };
  failed.click = () => { failed.clicks++; };
  const result = await fixture.run();
  assert.equal(result.status, 'Completed with errors');
  assert.deepEqual(Array.from(result.succeeded), ['delayed.go']);
  assert.deepEqual(Array.from(result.unchanged), ['already.go']);
  assert.equal(result.failed[0].path, 'failed.go');
  assert.equal(result.pending.length, 0);
  assert.equal(delayed.clicks, 1);
  assert.equal(failed.clicks, 1);
  assert.deepEqual(fixture.visits, ['already.go', 'delayed.go', 'failed.go', 900]);
});

test('changing PR or commit range stops before another click and does not scroll the new page', async () => {
  for (const part of ['pathname', 'search']) {
    const fixture = bulkFixture(['first.go', 'second.go']);
    fixture.entries[0].element.control.click = () => {
      fixture.sandbox.location[part] = part === 'pathname' ? '/owner/repo/pull/2/changes' : '?base=other';
    };
    const result = await fixture.run();
    assert.equal(result.status, 'Page changed');
    assert.equal(result.pending.length, 2);
    assert.equal(fixture.entries[1].element.control.clicks, 0);
    assert.deepEqual(fixture.visits, ['first.go']);
  }
});

test('manual stop and global timeout keep unconfirmed files in the unprocessed list', async () => {
  for (const status of ['Stopped', 'Timed out']) {
    const fixture = bulkFixture(['first.go', 'second.go']);
    fixture.entries[0].element.control.click = () => {
      if (status === 'Stopped') vm.runInContext("activeRun.status = 'Stopped'", fixture.sandbox);
      else fixture.setTime(120001);
    };
    const result = await fixture.run();
    assert.equal(result.status, status);
    assert.equal(result.pending.length, 2);
    assert.equal(result.succeeded.length, 0);
    assert.equal(fixture.entries[1].element.control.clicks, 0);
  }
});

test('unmounted files load through their tree links and unknown paths are reported separately', async () => {
  const fixture = bulkFixture(['lazy.go', '']);
  const entry = fixture.entries[0];
  const file = entry.element;
  fixture.files.delete(entry.id);
  delete entry.element;
  let navigations = 0;
  entry.link = {isConnected: true, click() { navigations++; fixture.files.set(entry.id, file); }};
  const result = await fixture.run();
  assert.equal(navigations, 1);
  assert.equal(file.control.clicks, 1);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.succeeded.length, 1);
  assert.equal(result.status, 'Completed with errors');
});

test('storage read failures block bulk actions and a successful retry restores the saved choice', async () => {
  const fixture = bulkFixture(['main.go']);
  const {sandbox} = fixture;
  sandbox.chrome.storage = {local: {get(defaults, callback) {
    sandbox.chrome.runtime.lastError = {message: 'Storage unavailable'};
    callback(undefined);
    delete sandbox.chrome.runtime.lastError;
  }}};
  sandbox.loadReviewCategories();
  assert.equal(vm.runInContext('settingsError', sandbox), 'Storage unavailable');
  assert.equal(vm.runInContext('selectedCategories.length', sandbox), 0);
  assert.equal(await fixture.run(), undefined);
  assert.equal(fixture.entries[0].element.control.clicks, 0);
  sandbox.chrome.storage.local.get = (defaults, callback) => callback({wghReviewCategories: ['go-test']});
  sandbox.loadReviewCategories();
  assert.equal(vm.runInContext('settingsError', sandbox), '');
  assert.equal(vm.runInContext('selectedCategories.join(",")', sandbox), 'go-test');
});

test('an incomplete file list is rejected before clicking any file', async () => {
  const fixture = bulkFixture(['first.go', 'second.go']);
  const getElement = fixture.sandbox.document.getElementById;
  fixture.sandbox.document.getElementById = (id) => id === 'prs-files-anchor-tab'
    ? {textContent: 'Files changed3 (3)'} : getElement(id);
  const result = await fixture.run();
  assert.equal(result.status, 'Failed');
  assert.match(result.failed[0].reason, /Only 2 of 3 files/);
  assert.equal(result.pending.length, 2);
  assert.equal(fixture.entries[0].element.control.clicks, 0);
});

test('stopping during directory expansion preserves the pending files', async () => {
  const fixture = bulkFixture(['first.go']);
  fixture.sandbox.document.querySelector = () => ({isConnected: true, getAttribute: () => 'false',
    firstElementChild: {click() { vm.runInContext("activeRun.status = 'Stopped'", fixture.sandbox); }}});
  const result = await fixture.run();
  assert.equal(result.status, 'Stopped');
  assert.equal(result.pending.length, 1);
  assert.equal(fixture.entries[0].element.control.clicks, 0);
});
