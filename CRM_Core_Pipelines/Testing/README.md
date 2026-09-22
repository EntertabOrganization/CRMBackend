# Executable Contract Tests

The TypeScript files in this directory intentionally fail until wired to the actual TrueCRM repository.

They are behavioral contracts, not throwaway examples.

The coding agent must:

1. inspect the repository test framework and helpers
2. move/adapt these scenarios into the established layout
3. replace placeholder `contract()` calls with real setup and assertions
4. keep the scenario intent intact
5. implement production code
6. run targeted tests
7. run real database/integration tests where persistence matters
8. run E2E authorization and cross-Workspace tests
9. run the full regression suite
10. only then report FINISHED

Do not:

- delete a required scenario
- skip it
- weaken the assertion
- convert it to `todo`
- mock away the database/authorization/state-machine behavior being implemented

Future-module integrations may use narrow deterministic fakes only at the defined interface boundary.
