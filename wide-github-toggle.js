function setDisabledClass(obj) {
  if (obj.enableWideGithub) {
    document.body.classList.remove('wgh-disabled');
  } else {
    document.body.classList.add('wgh-disabled');
  }
}

chrome.runtime.onMessage.addListener((request, sender, callback) => {
  setDisabledClass(request);
});

chrome.runtime.sendMessage({reload: true}, setDisabledClass);

const WGH_PR_ACTION_BAR_ID = 'wgh-pr-action-bar';
const WGH_PR_FILE_PATH = /^\/[^\/]+\/[^\/]+\/pull\/\d+\/(?:files|changes)(?:\/.*)?$/;
const WGH_ACTIONABLE_SELECTOR = [
  'button',
  'input',
  'label',
  'a[role="button"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
].join(', ');
const WGH_BULK_ACTION_POLL_MS = 250;
const WGH_BULK_ACTION_MAX_DURATION_MS = 120000;
const WGH_FILE_ACTION_TIMEOUT_MS = 5000;
const WGH_FILE_SELECTOR = '.file.js-file, [data-testid="diff-file"], [role="region"][id^="diff-"]';
const WGH_FILE_CATEGORIES = [
  ['all', 'All files'],
  ['markdown', 'Markdown'],
  ['rust', 'Rust'],
  ['generated', 'Generated code'],
  ['go', 'Go files'],
  ['go-test', 'Go test files'],
  ['frontend', 'Frontend files'],
  ['frontend-test', 'Frontend test files'],
  ['test', 'All test files'],
  ['other', 'Other files'],
];

let syncScheduled = false;
let domObserver = null;
let selectedCategories = null;
let generatedPagePath = '';
const generatedFilePaths = new Set();
let settingsError = '';
let activeRun = null;
let lastRun = null;

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isPullRequestFilesPage() {
  return location.hostname === 'github.com' && WGH_PR_FILE_PATH.test(location.pathname);
}

function isVisible(element) {
  return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function getLabelText(element) {
  if (!element.id) {
    return '';
  }

  const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
  return label ? label.textContent : '';
}

function getAccessibleText(element) {
  const parts = [];

  [
    'aria-label',
    'title',
    'data-testid',
    'data-view-component',
    'name',
    'value',
  ].forEach((attribute) => {
    const value = element.getAttribute(attribute);
    if (value) {
      parts.push(value);
    }
  });

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    labelledBy.split(/\s+/).forEach((id) => {
      const label = document.getElementById(id);
      if (label) {
        parts.push(label.textContent);
      }
    });
  }

  if (element.labels) {
    Array.from(element.labels).forEach((label) => parts.push(label.textContent));
  }

  if (element.tagName === 'INPUT') {
    parts.push(getLabelText(element));
  }

  const closestLabel = element.closest('label');
  if (closestLabel) {
    parts.push(closestLabel.textContent);
  }

  parts.push(element.textContent);

  return normalizeText(parts.join(' '));
}

function getTargetElement(element) {
  if (element.tagName === 'LABEL') {
    return element.control || element.querySelector('input, button, a, [role="button"], [role="tab"]') || element;
  }

  return element;
}

function isActive(element) {
  if (typeof element.checked === 'boolean') {
    return element.checked;
  }

  const stateAttributes = [
    element.getAttribute('aria-checked'),
    element.getAttribute('aria-pressed'),
    element.getAttribute('aria-selected'),
    element.getAttribute('aria-current'),
    element.getAttribute('data-selected'),
    element.getAttribute('data-active'),
    element.getAttribute('data-state'),
  ].map(normalizeText);

  return stateAttributes.some((value) => ['true', 'page', 'active', 'on', 'selected', 'checked'].includes(value));
}

function getActionTargets(matcher, root) {
  const elements = Array.from(root.querySelectorAll(WGH_ACTIONABLE_SELECTOR));
  const targets = [];
  const seen = new Set();

  elements.forEach((element) => {
    if (element.closest(`#${WGH_PR_ACTION_BAR_ID}`) || !isVisible(element) || element.disabled) {
      return;
    }

    const target = getTargetElement(element);
    if (!target || seen.has(target)) {
      return;
    }

    const text = getAccessibleText(element) || getAccessibleText(target);
    if (!matcher(target, text)) {
      return;
    }

    seen.add(target);
    targets.push(target);
  });

  return targets;
}

function getFileInventory() {
  const files = new Map();
  document.querySelectorAll(WGH_FILE_SELECTOR).forEach((element) => {
    const path = getFilePath(element);
    files.set(element.id || path || element, {path, id: element.id, element});
  });
  document.querySelectorAll('[role="treeitem"]:not([aria-expanded])').forEach((item) => {
    const link = item.querySelector('a[href^="#diff-"]');
    if (!link || !item.id) return;
    const id = link.getAttribute('href').slice(1);
    const existing = files.get(id);
    files.set(id, {...existing, path: existing?.path || item.id, id, link});
  });
  return Array.from(files.values());
}

function getExpectedFileCount() {
  const count = document.getElementById('prs-files-anchor-tab')?.textContent.match(/Files changed\s*(\d+)/i);
  return count ? Number(count[1]) : null;
}

function getRunPage() {
  return location.pathname + location.search;
}

function checkRun(run) {
  if (getRunPage() !== run.page || !isPullRequestFilesPage()) run.status = 'Page changed';
  else if (run.status === 'Running' && Date.now() - run.startedAt >= WGH_BULK_ACTION_MAX_DURATION_MS) {
    run.status = 'Timed out';
  }
  return run.status === 'Running';
}

async function waitForRun(check, run) {
  const startedAt = Date.now();
  while (checkRun(run)) {
    if (check()) return true;
    if (Date.now() - startedAt >= WGH_FILE_ACTION_TIMEOUT_MS) return false;
    await new Promise((resolve) => window.setTimeout(resolve, WGH_BULK_ACTION_POLL_MS));
  }
  return false;
}

function findFile(entry) {
  return (entry.id && document.getElementById(entry.id)) ||
    Array.from(document.querySelectorAll(WGH_FILE_SELECTOR)).find((file) => getFilePath(file) === entry.path);
}

async function runBulkAction(matcher, shouldClick, categories = null) {
  if (activeRun || settingsError) return;
  const run = {page: getRunPage(), startedAt: Date.now(), status: 'Running',
    succeeded: [], unchanged: [], skipped: [], failed: [], pending: [], unknown: []};
  activeRun = run;
  const initialScrollY = window.scrollY;
  try {
    const refreshPending = () => {
      const inventory = getFileInventory();
      run.unknown = inventory.filter((entry) => !entry.path).map((entry) => entry.id || 'Unknown file');
      run.pending = inventory.filter((entry) => entry.path && (!categories ||
        (!entry.element && categories.includes('generated')) || categories.some((category) =>
          matchesFileCategory(entry.path, category, entry.element ? isGeneratedFile(entry.element) : false))));
      return inventory.length;
    };
    refreshPending();
    scheduleSyncActionBar();
    // Expand directories so single-file/virtualized views also contribute their file links.
    let directory;
    while (checkRun(run) && (directory = document.querySelector('[role="tree"] [role="treeitem"][aria-expanded="false"]'))) {
      (directory.firstElementChild || directory).click();
      if (!await waitForRun(() => !directory.isConnected || directory.getAttribute('aria-expanded') !== 'false', run)) {
        if (checkRun(run)) throw new Error('Could not expand the file tree');
        break;
      }
    }
    if (!checkRun(run)) return run;
    const fileCount = refreshPending();
    if (!fileCount) throw new Error('No files found on this page');
    const expected = getExpectedFileCount();
    if (expected !== null && fileCount < expected) {
      throw new Error(`Only ${fileCount} of ${expected} files are listed. Expand the file tree or clear GitHub file filters and retry.`);
    }
    scheduleSyncActionBar();
    while (run.pending.length && checkRun(run)) {
      const entry = run.pending[0];
      try {
        let file = findFile(entry);
        if (!file && entry.link?.isConnected) entry.link.click();
        if (!await waitForRun(() => (file = findFile(entry)), run)) {
          if (!checkRun(run)) break;
          throw new Error('File did not load');
        }
        file.scrollIntoView({block: 'start'});
        let controls = [];
        const getControls = () => {
          const current = findFile(entry);
          return current ? getActionTargets(matcher, current) : [];
        };
        if (matcher === isViewedToggle) {
          if (!await waitForRun(() => (controls = getControls()).length > 0, run)) {
            if (!checkRun(run)) break;
            throw new Error('Viewed control did not load');
          }
        } else {
          controls = getControls();
        }
        if (!checkRun(run)) break;
        file = findFile(entry);
        if (categories && !categories.some((category) =>
          matchesFileCategory(entry.path, category, isGeneratedFile(file)))) {
          run.skipped.push(entry.path);
        } else if (!controls.length) {
          run.skipped.push(entry.path);
        } else if (!controls.some(shouldClick)) {
          run.unchanged.push(entry.path);
        } else {
          controls.filter(shouldClick).forEach((control) => control.click());
          let stablePasses = 0;
          const confirmed = await waitForRun(() => {
            const current = getControls();
            stablePasses = current.length && current.every((control) => !shouldClick(control)) ? stablePasses + 1 : 0;
            return stablePasses >= 2;
          }, run);
          if (!checkRun(run)) break;
          if (!confirmed) throw new Error('Control did not reach the requested state');
          run.succeeded.push(entry.path);
        }
      } catch (error) {
        if (!checkRun(run)) break;
        run.failed.push({path: entry.path, reason: error.message});
      }
      run.pending.shift();
      scheduleSyncActionBar();
    }
    if (checkRun(run)) run.status = run.failed.length || run.unknown.length ? 'Completed with errors' : 'Completed';
  } catch (error) {
    run.status = 'Failed';
    run.failed.push({path: 'File list', reason: error.message});
  } finally {
    if (getRunPage() === run.page) window.scrollTo(0, initialScrollY);
    run.pending = run.pending.map(({path}) => ({path}));
    activeRun = null;
    lastRun = run;
    scheduleSyncActionBar();
  }
  return run;
}

function isViewedToggle(element, text) {
  if (element.matches('.js-reviewed-checkbox')) {
    return true;
  }

  if (text.includes('viewed files') || text.includes('show viewed files')) {
    return false;
  }

  return /(?:^|\b)(?:mark file as viewed|mark as viewed|viewed)(?:\b|$)/.test(text);
}

function getFileContainer(element) {
  return element.closest('.file, [data-file-path], [data-testid="diff-file"], [role="region"][id^="diff-"]');
}

function getFilePath(element) {
  const file = getFileContainer(element);
  if (!file) {
    return '';
  }

  const pathElement = file.querySelector('[data-path], [data-file-path], .file-info a[title]');
  const headingLink = file.querySelector('h3 a[href^="#diff-"]');
  return file.getAttribute('data-path') || file.getAttribute('data-file-path') ||
    (pathElement && (pathElement.getAttribute('data-path') ||
      pathElement.getAttribute('data-file-path') || pathElement.getAttribute('title'))) ||
    (headingLink ? headingLink.textContent.replace(/[\u200e\u200f]/g, '').trim() : '');
}

function isGeneratedFile(element) {
  const file = getFileContainer(element);
  if (!file) {
    return false;
  }
  const path = getFilePath(element);
  const notice = file.querySelector('[data-diff-anchor] .fgColor-muted');
  if (file.matches('[data-generated="true"]') ||
    (notice && notice.textContent.includes('Some generated files are not rendered by default.'))) {
    // Keep GitHub's classification after Load Diff removes the notice.
    generatedFilePaths.add(path);
  }
  return !!path && generatedFilePaths.has(path);
}

function matchesFileCategory(path, category, generated = false) {
  if (category === 'all') {
    return true;
  }
  if (!path) {
    return false;
  }
  if (generated) {
    return category === 'generated';
  }
  if (/\.(?:md|markdown|mdown|mkd|mdx)$/i.test(path)) {
    return category === 'markdown';
  }

  const go = /\.go$/i.test(path);
  const rust = /\.rs$/i.test(path);
  const frontend = /\.(?:[cm]?[jt]sx?|vue|svelte|html|css|scss|sass|less)$/i.test(path);
  // shortcut: Infer tests from paths; add project-specific rules if naming differs.
  const test = /(?:^|\/)(?:__tests__|tests?|testdata|fixtures|cypress|e2e)\//i.test(path) ||
    /(?:^|[\/._-])(?:test|tests|spec)(?:[._-]|$)/i.test(path.split('/').pop());

  switch (category) {
    case 'rust': return rust;
    case 'go': return go && !test;
    case 'frontend': return frontend && !test;
    case 'go-test': return go && test;
    case 'frontend-test': return frontend && test;
    case 'test': return test;
    case 'other': return !go && !rust && !frontend && !test;
    default: return false;
  }
}

function isSourceToggle(element, text) {
  if (element.matches('.js-source')) {
    return true;
  }

  return /(?:display the )?source diff|(?:^|\b)source(?:\b|$)/.test(text);
}

function isRichDiffToggle(element, text) {
  if (element.matches('.js-rendered')) {
    return true;
  }

  return /(?:display the )?(?:rich diff|rendered)|(?:^|\b)(?:rich diff|rendered)(?:\b|$)/.test(text);
}

function createActionButton(label, title, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wgh-pr-action-button';
  button.textContent = label;
  button.title = title;
  button.dataset.wghAction = label;
  button.addEventListener('click', async () => {
    if (!activeRun && !settingsError) await action();
  });
  return button;
}

function createActionBar() {
  const bar = document.createElement('div');
  bar.id = WGH_PR_ACTION_BAR_ID;
  bar.className = 'wgh-pr-action-bar';
  const categories = document.createElement('details');
  categories.className = 'wgh-pr-categories';
  const summary = document.createElement('summary');
  summary.className = 'wgh-pr-action-button';
  const choices = document.createElement('fieldset');
  choices.className = 'wgh-pr-category-options';
  const legend = document.createElement('legend');
  legend.textContent = 'File categories';
  choices.append(legend);
  const saveStatus = document.createElement('span');
  saveStatus.setAttribute('role', 'status');
  const preview = document.createElement('span');
  preview.className = 'wgh-pr-preview';
  const progress = document.createElement('span');
  progress.className = 'wgh-pr-progress';
  progress.setAttribute('role', 'status');
  const resultDetails = document.createElement('details');
  resultDetails.className = 'wgh-pr-result-details';
  const resultSummary = document.createElement('summary');
  resultSummary.textContent = 'File details';
  const resultFiles = document.createElement('ul');
  resultDetails.append(resultSummary, resultFiles);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'wgh-pr-action-button';
  retry.textContent = 'Retry settings';
  retry.addEventListener('click', loadReviewCategories);
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'wgh-pr-action-button';
  stop.textContent = 'Stop';
  stop.addEventListener('click', () => {
    if (activeRun) activeRun.status = 'Stopped';
    scheduleSyncActionBar();
  });
  const categoryLabels = new Map();
  let previousDetails = '';
  function updateChoices() {
    const inventory = getFileInventory();
    const known = inventory.filter((entry) => entry.path && entry.element);
    const unloaded = inventory.filter((entry) => !entry.element).length;
    const unknown = inventory.filter((entry) => !entry.path).length;
    choices.querySelectorAll('input').forEach((input) => {
      input.checked = selectedCategories.includes(input.value);
      input.disabled = !!activeRun || !!settingsError;
    });
    WGH_FILE_CATEGORIES.forEach(([value, label]) => {
      const count = value === 'all' ? inventory.length : known.filter((entry) =>
        matchesFileCategory(entry.path, value, isGeneratedFile(entry.element))).length;
      const text = `${label} (${count})`;
      const node = categoryLabels.get(value);
      if (node.textContent !== text) node.textContent = text;
    });
    const labels = WGH_FILE_CATEGORIES.filter(([value]) => selectedCategories.includes(value))
      .map(([, label]) => label);
    const title = labels.length ? `Files: ${labels.join(', ')}` : 'Files: None';
    if (summary.textContent !== title) summary.textContent = title;
    summary.title = title;
    const matched = known.filter((entry) => selectedCategories.some((category) =>
      matchesFileCategory(entry.path, category, isGeneratedFile(entry.element)))).length;
    const expected = getExpectedFileCount() ?? inventory.length;
    const previewText = `Matches: ${matched} known; listed ${inventory.length}/${expected} files; ${unloaded} unloaded; ${unknown} unknown paths`;
    if (preview.textContent !== previewText) preview.textContent = previewText;
    const errorText = settingsError ? `Could not load categories: ${settingsError}. Bulk actions are disabled.` : '';
    if (settingsError && saveStatus.textContent !== errorText) saveStatus.textContent = errorText;
    retry.hidden = !settingsError;
    retry.disabled = selectedCategories === null;
    stop.hidden = !activeRun;
    stop.disabled = !activeRun || activeRun.status !== 'Running';
    bar.querySelectorAll('[data-wgh-action]').forEach((button) => {
      const noSelection = ['Review', 'Unreview'].includes(button.dataset.wghAction) && !selectedCategories.length;
      button.disabled = !!activeRun || !!settingsError || noSelection;
      button.classList.toggle('is-busy', !!activeRun);
    });
    const run = activeRun || lastRun;
    const progressText = run ? `${run.status}: ${run.succeeded.length} succeeded, ${run.unchanged.length} already matched, ${run.skipped.length} skipped, ${run.failed.length} failed, ${run.pending.length} unprocessed, ${run.unknown.length} unknown paths` : '';
    if (progress.textContent !== progressText) progress.textContent = progressText;
    const details = run ? [
      ...run.failed.map((file) => `Failed: ${file.path} — ${file.reason}`),
      ...run.pending.map((file) => `Unprocessed: ${file.path}`),
      ...run.unknown.map((id) => `Unknown path: ${id}`),
    ] : [];
    const detailsKey = JSON.stringify(details);
    if (detailsKey !== previousDetails) {
      resultFiles.replaceChildren(...details.map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }));
      previousDetails = detailsKey;
    }
    resultDetails.hidden = !details.length;
  }
  WGH_FILE_CATEGORIES.forEach(([value, text]) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = value;
    input.addEventListener('change', () => {
      if (input.checked) {
        selectedCategories = value === 'all' ? ['all'] :
          [...selectedCategories.filter((category) => category !== 'all'), value];
      } else {
        selectedCategories = selectedCategories.filter((category) => category !== value);
      }
      updateChoices();
      chrome.storage.local.set({wghReviewCategories: selectedCategories}, () => {
        saveStatus.textContent = chrome.runtime.lastError ?
          `Could not save categories: ${chrome.runtime.lastError.message}` : '';
      });
    });
    const countLabel = document.createElement('span');
    countLabel.textContent = text;
    categoryLabels.set(value, countLabel);
    label.append(input, countLabel);
    choices.append(label);
  });
  categories.append(summary, choices);
  bar.append(
    categories,
    createActionButton('Review', 'Mark files in the selected categories as reviewed', () => {
      categories.open = false;
      if (!selectedCategories.length) return;
      return runBulkAction(isViewedToggle, (element) => !isActive(element), [...selectedCategories]);
    }),
    createActionButton('Unreview', 'Clear reviewed state for files in the selected categories', () => {
      categories.open = false;
      if (!selectedCategories.length) return;
      return runBulkAction(isViewedToggle, (element) => isActive(element), [...selectedCategories]);
    }),
    createActionButton('Show source', 'Switch every diff to the raw source/text diff view', () => {
      return runBulkAction(isSourceToggle, (element) => !isActive(element));
    }),
    createActionButton('Show rich diff', 'Switch every supported diff to GitHub rich/rendered view', () => {
      return runBulkAction(isRichDiffToggle, (element) => !isActive(element));
    }),
    saveStatus,
    retry,
    stop,
    preview,
    progress,
    resultDetails,
  );
  bar.addEventListener('wgh:update', updateChoices);
  updateChoices();
  return bar;
}

function hasMultipleControls(element) {
  return element.querySelectorAll('button, summary, details, file-filter, [role="button"], [role="toolbar"]').length > 1;
}

function findClosestHost(element) {
  if (!element) {
    return null;
  }

  let current = element;
  while (current && current !== document.body) {
    if (isVisible(current) && hasMultipleControls(current)) {
      return current;
    }
    current = current.parentElement;
  }

  return element.parentElement && isVisible(element.parentElement) ? element.parentElement : null;
}

function findVisibleMatch(selectors) {
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    for (const match of matches) {
      if (isVisible(match)) {
        return match;
      }
    }
  }

  return null;
}

function findToolbarAnchorByText() {
  const toolbarAnchors = document.querySelectorAll('button, summary, [role="button"], a[role="button"]');
  for (const anchor of toolbarAnchors) {
    if (!isVisible(anchor)) {
      continue;
    }

    const text = getAccessibleText(anchor);
    if (text === 'all commits' || text.includes('submit review') || /\d+\s*\/\s*\d+\s+viewed/.test(text)) {
      return anchor;
    }
  }

  return null;
}

function findHostFromAnchors(anchors) {
  for (const anchor of anchors) {
    if (!anchor || !isVisible(anchor)) {
      continue;
    }

    const host = findClosestHost(anchor);
    if (host) {
      return host;
    }
  }

  return null;
}

function findActionBarHost() {
  const directHost = findVisibleMatch([
    'div[data-pjax="#repo-content-pjax-container"][data-turbo-frame="repo-content-turbo-frame"]',
    '.pr-toolbar .d-flex.flex-items-center.flex-wrap',
    '.gh-header-actions + div .d-flex.flex-items-center.flex-wrap',
  ]);
  if (directHost) {
    return directHost;
  }

  const selectorAnchors = Array.from(document.querySelectorAll([
    'file-filter',
    '.diffbar-range-menu',
    '.js-reset-filters',
    '[data-target="file-filter.summary"]',
    '[data-target="diff-file-filter.resetFilters"]',
  ].join(', ')));
  const anchoredHost = findHostFromAnchors(selectorAnchors);
  if (anchoredHost) {
    return anchoredHost;
  }

  const textAnchorHost = findHostFromAnchors([findToolbarAnchorByText()]);
  if (textAnchorHost) {
    return textAnchorHost;
  }

  return null;
}

function syncActionBar() {
  if (activeRun) checkRun(activeRun);
  const existingBar = document.getElementById(WGH_PR_ACTION_BAR_ID);

  if (!isPullRequestFilesPage()) {
    if (existingBar) {
      existingBar.remove();
    }
    return;
  }

  if (!document.body || selectedCategories === null) {
    return;
  }

  if (generatedPagePath !== location.pathname) {
    generatedFilePaths.clear();
    generatedPagePath = location.pathname;
  }
  document.querySelectorAll('.file, [role="region"][id^="diff-"]').forEach(isGeneratedFile);

  const host = findActionBarHost();
  if (!host) {
    return;
  }

  const bar = existingBar || createActionBar();
  if (bar.parentElement !== host) {
    host.appendChild(bar);
  }
  bar.dispatchEvent(new Event('wgh:update'));
}

function scheduleSyncActionBar() {
  if (syncScheduled) {
    return;
  }

  syncScheduled = true;
  window.requestAnimationFrame(() => {
    syncScheduled = false;
    syncActionBar();
  });
}

function loadReviewCategories() {
  chrome.storage.local.get({wghReviewCategories: ['all']}, (result) => {
    settingsError = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
    const saved = result && result.wghReviewCategories;
    selectedCategories = settingsError ? [] : Array.isArray(saved) ? saved.filter((value) =>
      WGH_FILE_CATEGORIES.some(([category]) => category === value)) : ['all'];
    if (selectedCategories.includes('all')) selectedCategories = ['all'];
    if (!settingsError) {
      const status = document.querySelector(`#${WGH_PR_ACTION_BAR_ID} [role="status"]`);
      if (status) status.textContent = '';
    }
    scheduleSyncActionBar();
  });
}

function initPullRequestActionBar() {
  if (domObserver) {
    return;
  }

  domObserver = new MutationObserver(scheduleSyncActionBar);
  domObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  ['DOMContentLoaded', 'pjax:end', 'turbo:load', 'turbo:render', 'popstate'].forEach((eventName) => {
    window.addEventListener(eventName, scheduleSyncActionBar, true);
  });

  loadReviewCategories();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPullRequestActionBar, {once: true});
} else {
  initPullRequestActionBar();
}
