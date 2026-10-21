# mark-schachner.com

The site is a GitHub Pages repo (`mschachner/site`) with a custom
domain (`CNAME` → mark-schachner.com). Anything committed to `main` is served at
`https://mark-schachner.com/<path>` within a couple of minutes of pushing.

Each project lives in **its own repo**. A GitHub Actions workflow in the project
repo pushes its deployable files into a subdirectory of this repo on every push
to `main`, so the site updates automatically. Never copy project files into this
repo by hand — they'd be overwritten by the next automated deploy.

## Layout

| Path | Maintained how |
| --- | --- |
| `index.html`, `research.html`, `projects.html`, `teaching_outreach.html`, `logsem.html`, `milestone.html`, `movienight.html` | By hand, in this repo |
| `assets/` | By hand, in this repo (shared CSS, `header.js` nav, images, documents) |
| `plates/` | By hand, in this repo — a permanent redirect to platesgame.com that migrates localStorage |
| `cryptographer/` | Deploy target — pushed by `mschachner/cryptographer` |
| `fences/` | Deploy target — pushed by the Fences+ repo |
| `leaper/` | Deploy target — pushed by the Leaper repo |
| `portfolio/` | Deploy target — pushed by the portfolio repo |
| `sokoban/` | Deploy target — pushed by `mschachner/sokoban` |

Deploy targets are overwritten wholesale on every push to the source repo's
`main`; never edit them here. `.nojekyll` disables GitHub Pages' Jekyll pass so
files beginning with `_` are served as-is.

## One-time setup per project

### 1. Make the project deployable from a subdirectory

**Plain static project (HTML/CSS/JS, no build step — e.g. sokoban):**
The source files *are* the deployable files. Make sure all asset references are
relative (`styles.css`, `js/main.js`, `new URL('./worker.js', import.meta.url)`),
not absolute (`/styles.css`).

**Project with a build step (e.g. leaper, a Vite app):**
Set the base path to the subdirectory it will live in — `base: '/<name>/'` in
`vite.config.js` (or `--base=/<name>/` on the build command). The deployable
files are the contents of `dist/`.

### 2. Create a deploy key

```sh
ssh-keygen -t ed25519 -f deploy_key -N "" -C "deploy <name> to site"
```

- On `mschachner/site` (Settings → Deploy keys → Add deploy key): set **Title**
  to anything descriptive (e.g. "deploy <name>"), paste the contents of
  `deploy_key.pub` (the public key) into **Key**, and check **Allow write
  access**. The `.pub` file is a single line (`ssh-ed25519 <key> <comment>`)
  even if your terminal wraps it — paste the whole thing as one line.
- In the **project** repo (Settings → Secrets and variables → Actions): add a
  secret named `SITE_DEPLOY_KEY` containing the contents of `deploy_key` (the
  private key, including the BEGIN/END lines).
- Delete both local key files afterwards.

### 3. Add the workflow to the project repo

`.github/workflows/deploy.yml` (replace `<name>` throughout):

```yaml
name: Deploy to site
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Build step — only for projects with a build step; for plain static
      # projects, skip this and copy the source files directly below.
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci && npm run build

      - name: Push to site repo
        env:
          DEPLOY_KEY: ${{ secrets.SITE_DEPLOY_KEY }}
        run: |
          eval "$(ssh-agent -s)"
          ssh-add - <<< "$DEPLOY_KEY"
          git clone --depth 1 git@github.com:mschachner/site.git site
          rm -rf site/<name>            # clear stale hashed assets
          mkdir -p site/<name>
          cp -R dist/. site/<name>/     # plain static: copy only what the browser needs instead
          cd site
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add <name>
          git diff --cached --quiet || git commit -m "Deploy <name> from ${GITHUB_SHA::7}"
          git push
```

For plain static projects, replace the `cp -R dist/.` line with copies of just
the files the browser needs (`index.html`, `styles.css`, `js/`, …) — skip
tests, configs, and `node_modules`.

### 4. Link it from the site

Add an entry to `projects.html` in this repo (a one-time manual commit),
following the existing pattern:

```html
<h3>Name</h3>
<h4><a href="https://mark-schachner.com/<name>/">Open Name</a></h4>
<p>Description…</p>
```

## Deploying updates

Push to `main` in the project repo. That's it — the workflow rebuilds and
pushes to the site automatically. Check the Actions tab in the project repo if
the site doesn't update.

## Verify

After a minute or two, check `https://mark-schachner.com/<name>/`. Open the
browser console: 404s on assets almost always mean an absolute path or a wrong
`base`. Hard-refresh (Cmd+Shift+R) if you see a stale version.

## Gotchas

- **Absolute paths** (`/asset.png`) break in subdirectories; use relative paths
  or the build tool's base option.
- **Web workers**: load via `new URL('./worker.js', import.meta.url)` so the
  path resolves relative to the module, not the page.
- **Don't deploy source-only files** (tests, configs, `node_modules`) — only
  what the browser fetches.
- **GitHub Pages serves files as-is**: no server-side code; anything dynamic
  must run client-side or call an external API.
- **Race conditions**: two project workflows pushing at the same moment can
  conflict; the loser fails on `git push`. Just re-run the failed job.
- **Don't edit project subdirectories in this repo** — changes will be wiped by
  the next automated deploy. Edit the project repo instead.
