# Improvements after the publication review

**Status on 18 November 2026.** The table below describes the 0.2.0 review baseline. The fixes, test results and remaining publication steps for 0.2.1 are recorded in the [release verification](release-verification.md).

This backlog follows the code and test review. Priority reflects user impact and implementation cost. The proposed targets below are acceptance criteria for future work.

| Order | Opportunity | First deliverable | How to decide whether it worked |
| --- | --- | --- | --- |
| 1 | Make history reliable across many projects | Add project and status filters, cursor-based terminal history, and direct run lookup. Show the source project and owner in the result view. | From a cold start with 150 terminal runs, find the oldest and open its result without changing another project’s selection. Measure dashboard latency before and after. |
| 2 | Make the monitor usable in a narrow sidebar | Stack the run picker and primary action when space is limited. Keep two-dimensional scrolling inside the graph or table. The baseline monitor already showed horizontal overflow. | At 320 and 480 CSS pixels, use the run switcher, recovery, result tab and task controls without horizontally scrolling ordinary text or actions. Test both languages. |
| 3 | Support graph editing with the keyboard | Add a keyboard connection flow to the isolated editor. Its output port currently starts a connection on pointer-down. Preserve focus after graph redraws and expose the selected edge and cycle errors. | Using only Tab, Enter and Escape, connect A to B, inspect the edge, remove it, and recover from a rejected cycle. Repeat with assistive technology. |
| 4 | Explain model availability at the point of choice | Distinguish an undiscovered catalog, an incompatible Orca version, and a saved model that is no longer available. Keep agent defaults usable. | For each state, a first-time user can explain why the model is missing and either refresh or start with a supported default. |
| 5 | Shorten the path from a failed result to its evidence | In the run summary show the failed step, first failing check, exit status and a link to the existing attempt. Keep raw provider output one action away. | From the results tab, identify the failing check and open its exact attempt in at most two actions, including a partial run. |
| 6 | Reduce the cost of maintaining two interfaces | Extract panel views by feature along existing request boundaries. Move newly generated diagnostics to stable message IDs with typed parameters. Preserve raw technical messages and compatibility with saved legacy diagnostics. | A new validation rule gains EN/RU coverage in one place, and the existing panel, editor and terminal tests still pass. |

The narrow-layout criteria use WCAG’s reflow guidance, which explicitly allows two-dimensional scrolling for diagrams. The keyboard proposal keeps a pointer-free route for endpoint-based actions such as connecting two nodes. [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) · [W3C keyboard guidance](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html)

A useful first usability session would give three tasks to people unfamiliar with the plugin: find an older run, explain which step is blocked and why, then recover a paused run without repeating completed work. Record task completion, wrong-run actions and time to the first correct next action. These measures would validate or revise the ordering above.
