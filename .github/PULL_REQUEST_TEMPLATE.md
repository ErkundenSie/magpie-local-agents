## What this changes

<!-- One or two sentences. Link the issue it closes, if any. -->

Closes #

## Why

<!-- The problem this solves. If it is a protocol change upstream, say which version and what changed. -->

## How it was verified

<!--
- `bun test` result
- Which fixture covers this, if the change is protocol-level
- If you touched a real CLI: which one, which version
-->

## Checklist

- [ ] `bun test` passes
- [ ] A test covers this, or I explained why one cannot (the suite must not need a login)
- [ ] Errors raised by this change name the offending field or tool
- [ ] No new dependencies
- [ ] No tokens, credentials, or machine-specific absolute paths
- [ ] `README.md` and `README.zh-CN.md` updated, if behaviour changed
- [ ] Gateway sessions stay constrained; if a new CLI, it has an isolation story
