# web-diii

a web-based alternative to diii

to run locally run this in the web-diii root directory then browse to localhost:8000
```bash
python3 -m http.server 8000
```

## GitHub Pages deployment (Not enabled until repo is made public)

This repo includes GitHub Actions workflows for Pages:

- Pushes to `main` deploy to production Pages.
- PRs targeting `main` deploy to preview URLs.

Notes:

- PR preview deployments run only for PRs from branches in this repository (not forks).
- The preview URL is shown in the PR checks/deployment details.
