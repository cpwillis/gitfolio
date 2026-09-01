# Contributing

## Scope

gitfolio is deliberately small: one Worker, two HTML files, zero dependencies. Changes that add a
framework, a build step, or an npm dependency will not be merged. If something can be done with a
platform feature, use the platform feature.

Good contributions: bug fixes, accessibility fixes, browser compatibility, clearer docs, and
options that stay off by default.

## Working on it

Running it locally is in the [README](README.md#develop). There is no test suite: verify by loading
the page and watching the three stages resolve.

Repo data comes from a third-party API, so never build DOM with `innerHTML` and string
interpolation. Use `textContent`, as the existing code does.

## Pull requests

One change per PR. Say what it does and why in the description; the checklist is in the PR
template. Lowercase, present-tense commit messages, no trailing full stop.
