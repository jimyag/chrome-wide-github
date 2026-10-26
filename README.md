Wide GitHub
===========

This plugin changes all GitHub repository pages to be full width and dynamically sized. Gists are supported as of version 1.1.0.

This repository always contains the latest version, the Chrome and Firefox extension updates may be delayed by submission reviews.

Installing
----------

As a Chrome Extension:

The Chrome extension can be installed from the [Chrome Web Store](https://chrome.google.com/webstore/detail/wide-github/kaalofacklcidaampbokdplbklpeldpj)

As a Firefox Addon:

The Firefox addon can be installed from the [Mozilla Addons Website](https://addons.mozilla.org/firefox/addon/wide-github-chrome/)

As a Greasemonkey / UserScript:

This script can be installed into Greasemonkey or other user script plugins by going here: [wide-github.user.js](https://raw.githubusercontent.com/xthexder/wide-github/master/build/wide-github.user.js)

As a Stylus / UserCSS

This style can be installed into Stylus by going here: [wide-github.user.css](https://raw.githubusercontent.com/xthexder/wide-github/master/build/wide-github.user.css)

Pull request actions
--------------------

In the Chrome and Firefox extensions, open the Files menu on the pull request
Files changed action bar and check one or more categories before clicking Review
or Unreview. Files matching any selected category are included. All files clears
the other choices; choosing a specific category clears All files. Selecting no
categories disables Review and Unreview. Your selection is saved in the
extension's local storage and restored across pull requests and browser restarts.

Available categories:

- Markdown: `.md`, `.markdown`, `.mdown`, `.mkd`, and `.mdx`.
- Rust: `.rs`, including Rust test files.
- Generated code: files GitHub identifies with its generated-file notice or
  `data-generated="true"` marker. No diff needs to be loaded to mark them Viewed.
  The classification is remembered within the current PR page after Load Diff.
  GitHub must expose that notice or marker while the extension is active; files
  already rendered without either signal cannot be identified as generated.
- Go files and Go test files: `.go`, separated by test naming.
- Frontend files and Frontend test files: JS/TS (including JSX, TSX, MJS and CJS),
  Vue, Svelte, HTML, and CSS/SCSS/Sass/Less, separated by test naming.
- All test files: tests across languages, excluding generated files and Markdown.
- Other files: files outside all the categories above.
- All files: includes every file, including generated files.

Generated files are excluded from the language and test categories. Tests are
identified by `test`, `tests`, or `spec` filename segments (including Go's
`_test.go`), or directories named `test`, `tests`, `__tests__`, `testdata`,
`fixtures`, `cypress`, or `e2e`. Tests defined inside a regular Rust source file
remain in Rust; the extension does not inspect code to classify tests.

The menu shows counts for known file categories, a preview of matches, and counts
of unloaded files and unknown paths. Counts can change as files load. Review and
Unreview process files individually using the diff containers and file tree,
including files above the current scroll position. Collapsed tree directories
are expanded, and unloaded diffs are opened through their file links. If GitHub
reports more changed files than the extension can list, the operation stops
before clicking any file; clear GitHub's file filters or expand the file tree
and retry. Files with unknown paths are listed separately and are not clicked.

Each control is clicked once and checked for the requested UI state. A file has
5 seconds to load its control or confirm the change; failures are listed by path
and the operation continues with the remaining files. The entire operation has
a 120-second limit. Results distinguish completion, errors, timeout, manual stop,
and page changes, with counts of succeeded, already matched, skipped, failed,
unprocessed, and unknown files. File details lists failures and remaining paths.

Stop prevents further clicks and leaves completed changes in place; an in-flight
change is not undone and remains unprocessed until confirmed by a later run.
Changing the PR or commit-range URL also stops the operation. The original scroll
position is restored only when still on the same page. Show source and Show rich
diff use the same per-file processing and apply to all supported files.

If saved categories cannot be read, an error is shown and all bulk actions are
disabled. Retry settings reloads the saved selection without falling back to
All files.

Development
-----------

Run `node --test wide-github-toggle.test.js` to check classification, per-file
processing, incomplete lists, cancellation, timeouts, and storage-read recovery.

To generate the user.js for Greasemonkey, run `make js`.

The user.css can be built using `make css`.

Build both browser extensions with `make chrome-extension mozilla-extension`.

