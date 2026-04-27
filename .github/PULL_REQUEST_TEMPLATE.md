## What

<!-- 1–2 sentence description of the change -->

## Why

<!-- Linked issue, runbook reference, or short justification -->

## Architecture compliance

- [ ] No cross-imports between workflow modules (no `../<other-workflow>/` imports)
- [ ] Schema changes (if any) reviewed against `ARCHITECTURE.md` and `pipelines/SETUP.md`
- [ ] `user_owner` scoping respected on any new query
- [ ] No new DB engines / no runtime ALTER TABLE pattern
- [ ] Slack-handoff vs webapp-execution surface respected (per `pipelines/SETUP.md` §14)
- [ ] No "Phavella" or other banned strings introduced

## Test plan

<!-- How to verify this works. Commands to run. Screenshots if UI. -->

## Screenshots / output

<!-- If UI or generated artifacts changed -->
