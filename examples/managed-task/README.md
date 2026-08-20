# Managed task

First create an active session and navigate it through the relay. Then run:

```bash
SURFGATE_API_KEY='sg_test_...' \
SURFGATE_SESSION_ID='ses_...' \
SURFGATE_TASK_TYPE='extract' \
node examples/managed-task/index.mjs
```

`SURFGATE_TASK_TYPE` may be `extract`, `screenshot`, or `pdf`. Screenshot/PDF artifacts are downloaded to the current directory only after tenant-authorized API access.

Task delivery is at least once. An unsupported task is rejected for the existing runtime; SurfGate does not allocate a replacement browser.
