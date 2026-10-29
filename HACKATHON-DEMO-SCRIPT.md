# PatchProof hackathon submission kit

## Positioning

**Track:** Coding and Agentic Engineering.

**One-line pitch:** PatchProof turns a coding request into a focused repository change with local check results and a reviewable verification receipt.

**Project description:** PatchProof is an evidence-first coding agent for developers reviewing AI-assisted code changes. NVIDIA Nemotron 3.5 Lightning runs through Nebius Token Factory to inspect a selected repository, diagnose a failing behavior, and make a focused patch using workspace tools. PatchProof then runs the repository’s configured checks locally, shows the actual output, and saves a JSON receipt with the task, scripts, result, timing, and provider/model. Developers can review the receipt alongside the Git diff before accepting the change.

## Three-minute demo script

Record with a real Nebius Token Factory connection and the NVIDIA Nemotron model selected. The mock provider does not meet the model requirement. Keep the API key off screen. Start with the clean `cart-checkout` demo repo and select its folder as the project workspace. The starter test is intentionally failing.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:20 | PatchProof chat, then the cart repo | “AI coding tools can produce a convincing patch without showing whether the project’s own checks pass. PatchProof is built for the moment after an AI suggests a change: it makes the work and the evidence reviewable.” |
| 0:20–0:40 | Settings showing Nebius and the Nemotron model; do not reveal the key | “For this run, NVIDIA Nemotron 3.5 Lightning is called through Nebius Token Factory. The model inspects the selected code. Verification runs locally in that repository.” |
| 0:40–1:05 | Paste the prompt below and send it | “This checkout bug is small and concrete: the total ignores item quantity. I’ll ask the agent to capture the failing baseline, fix the source without changing the test, and verify the patch.” |
| 1:05–1:40 | Show tool activity and the baseline failure | “PatchProof reads the relevant source and test, then runs the project’s configured check. The test exposes the wrong total: the cart counts each product once instead of multiplying by quantity.” |
| 1:40–2:05 | Show the edited source and the verification panel | “The agent changes the calculation and reruns the check. The panel shows the real command result, whether it passed, and the saved receipt. If a related check still failed, the agent can inspect that output and make a targeted correction.” |
| 2:05–2:35 | Show the receipt path/output, then Git diff | “The receipt records the task, script, status, timing, output, and model used. The Git diff shows the exact source change, while the test stays unchanged. That gives a reviewer concrete evidence to consider alongside code review.” |
| 2:35–3:00 | Show the repo guide with the other two scenarios | “The same workflow covers a reading-progress rounding bug and reserved inventory. PatchProof is designed to make AI-assisted changes easier to verify, not to replace the developer’s review.” |

### Prompt to paste

> Fix the checkout total bug in this repository. Inspect the source and existing tests, then run `verify_project` to capture the baseline failure. Make the smallest source-only fix so each item contributes `price × quantity`; do not change the tests. Run `verify_project` again, inspect `git_diff`, and report the before-and-after results and receipt paths.

## Submission-period work disclosure

The Git history shows that AngChat began before the hackathon’s submission period. During the submission period, it was substantially developed into PatchProof: a SQLite-backed, streaming coding agent; repository selection with bounded file tools and Git inspection; an agent tool loop for reading, editing, and running code; allowlisted local verification with JSON receipts; and a Nebius Token Factory provider preset for NVIDIA Nemotron. The project also gained a model library, persistent sessions, and deployment configurations. The submission’s central contribution is the workflow that pairs an AI-generated patch with locally executed checks and a reviewable receipt.

Adjust this statement if the project history or dates you submit differ from the repository history.

## Before submitting

- Make the source repository public and confirm the MIT license and setup steps are visible.
- Publish a working demo URL and verify it with the same Nebius/Nemotron workflow used in the video.
- Upload the public video to YouTube and keep it under three minutes.
- Confirm the app is making a real Nebius Token Factory inference call; do not use mock mode in the recorded run.
- Add your honest feedback about Nebius Token Factory and NVIDIA tools/models to the submission.
- Submit under Coding and Agentic Engineering and include the project description and submission-period work disclosure above.

The official deadline is October 30, 2026 at 10:00 a.m. PDT (10:30 p.m. India time). Check the [official rules](https://nebiusglobalaihackathon.devpost.com/rules) before submitting.
