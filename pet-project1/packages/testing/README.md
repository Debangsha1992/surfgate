# packages/testing

Reusable provider conformance tests, fixtures, fake servers.

The package currently provides:

- `FakeBrowserProvider`, a deterministic, no-network `BrowserProvider` driven by
  immutable scenario data;
- safe fixed provider/allocation fixtures;
- `runProviderConformanceSuite()`, the exact lifecycle contract every concrete
  provider adapter must run.

Provider test harnesses implement the named `ProviderConformanceScenario`
factory and invoke:

```ts
runProviderConformanceSuite({
  name: 'ProviderName',
  createProvider: (scenario) => createScenarioProvider(scenario),
  allocateRequest: () => createProviderAllocateRequest(),
})
```

The suite validates descriptor and health schemas, configured state,
allocation/session normalization, cancellation, timeouts, mapped failures,
secret sanitization across every lifecycle operation, successful termination,
repeated/nonexistent termination, and unknown exception wrapping. Health,
allocation, and termination are all checked for bounded timeout and AbortSignal
behavior. Scenario harnesses may use a local fake upstream but must not change
or monkey-patch the shared assertions.

Run only provider conformance tests with:

```bash
pnpm --filter @surfgate/testing test:conformance
```
