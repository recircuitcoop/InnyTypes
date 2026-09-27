# Competitive UX analysis

Done 2026-09-27 for the UX rework. The research came from the official docs and marketing pages
only: web search was unavailable, so the notes on visual style come from the pages' own text, not
from screenshots.

## Products looked at

n8n, Node-RED/FlowFuse, Zapier, Make, Apple Shortcuts, Home Assistant, Raycast and Hazel, Anytype,
and the meeting-recorder apps Granola, Otter and MacWhisper, which do the same job with no flows at
all.

## What they all have (table stakes)

- A history of runs, where each step can be inspected and retried.
- Accounts and connections kept in one place, apart from the automations that use them.
- **Templates as the way in**, rather than a blank canvas.
- An AI helper that builds an automation from a description.
- For meeting transcription: **nothing to set up**. Install, and the notes appear.

## Patterns worth borrowing

| Pattern | From | Why it fits InnyTypes |
|---|---|---|
| Notifications with buttons in them, so a person answers without opening the app, with each button tied to its own run | Home Assistant | The best way seen to handle "the flow waits for you" while the flow runs in the background |
| "Ask for Input": a small question asked in place, in the middle of a flow | Apple Shortcuts | The right weight for a small decision such as naming a speaker |
| A Wait step that resumes from a generated form, a webhook or a timer | n8n | Technically the same thing as an action view |
| A run history that explains failures in plain words, with retries | Zapier | The right tone for someone checking on a long transcription |
| Coloured "bubbles" showing which output feeds which input | Make | The most approachable way seen to connect fields |
| Blueprints: a shared automation a person fills in without touching the editor | Home Assistant | A way to ship the owner's pipeline as something that works out of the box |

## The gap nobody fills

Nothing combines all three:
1. local-first data;
2. a clear step where the flow stops and asks the person;
3. a fixed destination in a knowledge app the person already trusts.

n8n has the waiting step but no destination and no local-first story. Home Assistant has the best
way of asking, but no knowledge app behind it. Anytype has the destination but no automation. This
is the space InnyTypes can own.

## The biggest threat: meeting-recorder apps

Granola, Otter and MacWhisper win on effort alone: nothing to configure. InnyTypes' real
advantages only count if the first flow runs in about as few clicks as installing Granola. Those
advantages are:
- work that survives unplugging the recorder or the laptop sleeping;
- real decisions put to the person;
- linked objects in Anytype rather than a flat note;
- sending results on to customer spaces and planning the next steps.

## Sources

- n8n: https://n8n.io/, https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/,
  https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.form/
- Node-RED and FlowFuse: https://nodered.org/docs/user-guide/editor/, https://flowfuse.com/
- Zapier: https://zapier.com/features, https://zapier.com/tables
- Make: https://www.make.com/en/product
- Apple Shortcuts: https://support.apple.com/guide/shortcuts/welcome/ios
- Home Assistant: https://www.home-assistant.io/docs/automation/editor/,
  https://www.home-assistant.io/docs/automation/using_blueprints/,
  https://companion.home-assistant.io/docs/notifications/actionable-notifications/
- Raycast and Hazel: https://www.raycast.com/, https://www.noodlesoft.com/
- Anytype: https://doc.anytype.io/
- Granola and Otter: https://www.granola.ai/, https://otter.ai/
