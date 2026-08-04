# GitHub via CLI (`gh`)

New Project → **Create on GitHub** uses the [GitHub CLI](https://cli.github.com) already installed on your machine. No OAuth App registration inside AIFI.

## Prerequisites

1. Install `gh`: https://cli.github.com
2. Authenticate once in a terminal:

```bash
gh auth login
```

3. Confirm:

```bash
gh auth status
gh api user --jq .login
```

## What the IDE does

1. Checks `gh` is installed and authenticated (`gh auth status`)
2. Loads your user login and organizations (`gh api user`, `gh api user/orgs`)
3. Lets you pick **owner** (you or an org) + repo name + private/public
4. Runs (no push — empty repo has no commits yet):

```bash
gh repo create OWNER/NAME --private|--public --source=. --remote=origin
```

5. Opens the workspace and Architecture chat

## Alternatives in the wizard

- **Skip** — local folder + `git init` only
- **Remote URL** — set `origin` to an existing URL (no `gh` required)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| “gh is not installed” | Install CLI; restart the IDE so PATH is picked up |
| “Not authenticated” | `gh auth login`, then **Refresh status** in the dialog |
| Wrong GitHub user signed in | Click **Log out**, then **Sign in with browser** (or **Use token**) |
| Prefer no browser | **Use token** → paste a PAT with `repo` scope → **Sign in** |
| Browser does not open on **Sign in with browser** | Without a TTY, `gh` only prints the device URL — the IDE opens it via the system browser and copies the one-time code. If it still fails, open https://github.com/login/device and paste the clipboard code, or use **Use token** |
| Org missing from owner list | Ensure the token can list orgs (`gh api user/orgs`) |
| “Name already exists” | Pick another repo name or owner |

## Note on OAuth Apps

Device Flow / OAuth App Client IDs are **not** used for this path. Prefer `gh` for desktop.
