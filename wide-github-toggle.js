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
const WGH_RETRY_DELAYS_MS = [0, 250, 1000];

let syncScheduled = false;
let domObserver = null;

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

function getActionTargets(matcher, shouldClick) {
  const elements = Array.from(document.querySelectorAll(WGH_ACTIONABLE_SELECTOR));
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

    if (!shouldClick(target, text)) {
      return;
    }

    seen.add(target);
    targets.push(target);
  });

  return targets;
}

function runBulkAction(matcher, shouldClick) {
  WGH_RETRY_DELAYS_MS.forEach((delay) => {
    window.setTimeout(() => {
      getActionTargets(matcher, shouldClick).forEach((element) => element.click());
    }, delay);
  });
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

function setButtonBusy(button, isBusy) {
  button.disabled = isBusy;
  button.classList.toggle('is-busy', isBusy);
}

function createActionButton(label, title, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wgh-pr-action-button';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', () => {
    setButtonBusy(button, true);
    action();
    window.setTimeout(() => setButtonBusy(button, false), WGH_RETRY_DELAYS_MS[WGH_RETRY_DELAYS_MS.length - 1] + 250);
  });
  return button;
}

function createActionBar() {
  const bar = document.createElement('div');
  bar.id = WGH_PR_ACTION_BAR_ID;
  bar.className = 'wgh-pr-action-bar';
  bar.append(
    createActionButton('Review all', 'Mark every file as reviewed', () => {
      runBulkAction(isViewedToggle, (element) => !isActive(element));
    }),
    createActionButton('Unreview all', 'Clear reviewed state for every file', () => {
      runBulkAction(isViewedToggle, (element) => isActive(element));
    }),
    createActionButton('Show source', 'Switch every diff to the raw source/text diff view', () => {
      runBulkAction(isSourceToggle, (element) => !isActive(element));
    }),
    createActionButton('Show rich diff', 'Switch every supported diff to GitHub rich/rendered view', () => {
      runBulkAction(isRichDiffToggle, (element) => !isActive(element));
    }),
  );
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
  const existingBar = document.getElementById(WGH_PR_ACTION_BAR_ID);

  if (!isPullRequestFilesPage()) {
    if (existingBar) {
      existingBar.remove();
    }
    return;
  }

  if (!document.body) {
    return;
  }

  const host = findActionBarHost();
  if (!host) {
    return;
  }

  const bar = existingBar || createActionBar();
  if (bar.parentElement !== host) {
    host.appendChild(bar);
  }
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

  scheduleSyncActionBar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPullRequestActionBar, {once: true});
} else {
  initPullRequestActionBar();
}
