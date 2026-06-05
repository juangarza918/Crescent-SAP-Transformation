# Crescent SAP Transformation — Executive Dashboard

Live URL (once Pages finishes building):
**https://juangarza918.github.io/Crescent-SAP-Transformation/**

## How it works

- **Viewers** just open the URL — they see the latest published data, no sign-in.
- **Editors** click **Sign in to edit** (top right), paste a GitHub PAT once, then make changes in the **Edit data** tab and click **↑ Publish to team** to push the new state back to this repo. The Pages site refreshes within ~1 minute.

## Files in this repo

- **index.html** — the dashboard (single self-contained file).
- **data.json** — the published project data (schedule, milestones, risks, status).
- **README.md** — this file.

## Editing online (for team members)

1. Open the live URL.
2. Click **Sign in to edit** at the top right.
3. Paste a GitHub Personal Access Token. Easiest: go to https://github.com/settings/tokens/new, name it "Crescent SAP Dashboard", scope **`repo`**, generate, copy.
4. Go to the **Edit data** tab — change dates, %, status, milestones, risks, etc. Edits save automatically in your browser as you type.
5. Click **↑ Publish to team** when ready. That commits the new `data.json` to this repo and the Pages URL updates within a minute.
6. Use **Pull latest** if you want to discard local edits and reload whatever was last published.

## Editing offline / one-off

You can also download `index.html` and open it locally — it still works fully offline (no sign-in needed for personal use). Use **Export backup** / **Import** to move data between machines.

## Notes

- The dashboard is a single self-contained file — no build step, no runtime dependencies.
- The PAT is stored only in the signed-in browser's localStorage, never sent anywhere except `api.github.com`.
- Each edit creates a normal git commit in this repo, so you get free version history. To roll back, revert that commit in GitHub and refresh the dashboard.
- If two editors publish at the same time, the second will get a conflict warning — use **Pull latest** then republish.
