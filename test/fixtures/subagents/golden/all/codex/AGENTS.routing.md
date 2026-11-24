<!-- human-hindsight suggested subagents · generated 2026-11-20 · add to AGENTS.md -->
## Specialist routing

For substantial work, delegate a well-defined, independent part to the specialist whose row matches it, and handle small edits and simple lookups directly.
The coordinating assistant stays responsible for the user's goal, the decisions made along the way, and the final integration of delegated work.
A specialist does not route work to another specialist; it returns its result to the coordinator.

| Specialist | Delegate when | Not for |
| --- | --- | --- |
| evidence-analyst | The task needs a number, a comparison or a conclusion drawn from data, records or experiments. | Changing production data, or writing the final prose of a document. |
| release-engineer | The task changes stored data, runs a migration, or ships a build to a shared environment. | Exploratory analysis or wording changes in documents. |
| docs-editor | A README, design note or readout needs drafting or editing for people outside the work. | Computing the numbers a document reports, or changing code. |
