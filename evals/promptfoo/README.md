# Paperclip heartbeat evals (promptfoo)

Narrow, model-matrix behavior evals for the Paperclip heartbeat prompt.

## Prompt parity

The eval prompt (`prompts/heartbeat-system.generated.txt`) is **generated** from
the shipped agent-prompt template — `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` and
`renderPaperclipWakePrompt` in `packages/adapter-utils`. This replaces the old
hand-written `heartbeat-system.txt`, which was a frozen fork that had drifted
from the real prompt.

- **Regenerate** after changing the shipped template or the fixtures in
  `scripts/render-eval-prompt.ts`:

  ```sh
  pnpm evals:heartbeat-prompt:generate
  ```

- **Check** that the committed prompt is in sync (this is the CI gate — it fails
  when the shipped template changes without regenerating):

  ```sh
  pnpm evals:heartbeat-prompt:check
  ```

Do not hand-edit `prompts/heartbeat-system.generated.txt`.

## Running the evals

Requires `OPENROUTER_API_KEY` (or individual provider keys):

```sh
cd evals/promptfoo && promptfoo eval
promptfoo view   # open results in a browser
```
