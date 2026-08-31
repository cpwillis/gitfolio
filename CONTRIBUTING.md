# Contributing

## Scope

gitfolio is deliberately small: one HTML file, one Worker, zero dependencies. Changes that add a
framework, a build step, or an npm dependency will not be merged. If something can be done with a
platform feature, use the platform feature.

Good contributions: bug fixes, accessibility fixes, browser compatibility, clearer docs, and
options that stay off by default.

## Develop

```bash
npx wrangler@4 dev
```

Not `--local`, see the README for why. There is nothing to install and no test suite; verify by
loading the page and checking the three stages resolve.

Worth checking before opening a PR:

- Page renders with JavaScript disabled (the `<noscript>` path)
- `prefers-reduced-motion: reduce` stops the glow and the starfield
- No horizontal overflow at 375px
- `npx wrangler@4 deploy --dry-run` still lists `env.BROWSER` and `env.ASSETS`

## Pull requests

One change per PR. Say what it does and why in the description. Lowercase, present-tense commit
messages, no trailing full stop.

Repo data comes from a third-party API, so never build DOM with `innerHTML` and string
interpolation. Use `textContent`, as the existing code does.
