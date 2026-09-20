---
name: preview
description: Guidance for inline previews of prospective interface/frontend work in Vulcan. Read this when a concrete rendition could help the user see your interpretation, react to it, and sharpen what should be built while the target is still being defined.
---

# Preview

A preview is a concrete, interactive interpretation of proposed interface or frontend work, rendered inline in the chat so the user can see how you are understanding what they want and react to it while the target is still being defined. A Preview can be polished and functional; what makes it a Preview is that it represents a proposal or interpretation, not the authoritative running application.

## When to preview

Use `preview` when an idea, feature, mode, workflow, page, component, layout, or interaction is still being worked out and a visible candidate would help the user confirm, correct, or sharpen your interpretation. Preview can be proactive when externalizing that interpretation would materially reduce ambiguity, even if the user did not explicitly ask for one.

Do not create a Preview merely because HTML could represent the answer. The point is to help shape what should be built through reaction to a concrete candidate.

## Preview vs. visualization

A visualization is a quick visual answer. It is demonstrative, elective, casual, and part of the conversation itself; use it when showing an idea communicates the answer better than prose.

Preview serves a different purpose: it externalizes your interpretation of prospective work so the user can react to the candidate and make the intended result more precise. A rough UI sketch can be a visualization when the sketch itself is the explanation; use Preview when the candidate is helping define what should be built.

## Preview vs. Design

Preview represents a proposal or interpretation. Design is the actual running frontend. Use Preview while the target is still being defined and a concrete candidate would help establish it. If the task is to refine the actual runnable frontend with precision, use Design instead.

Preview may precede Design, but it is not a required staging step. If the target is already clear enough to build or refine directly, go straight to the real implementation and Design when appropriate.

## Preview vs. dashboard

Preview and Dashboard share the same web-bundle model: HTML, CSS, and JavaScript are separate inputs and are composed into an isolated rendered document.

Their placement and lifecycle differ:

- **Preview** — inline in the transcript, proposal-oriented, disposable, not an Artifact, not persistent workspace UI.
- **Dashboard** — persistent workspace/sidebar surface intended to remain useful between messages.

A complex or interactive Preview does not become a Dashboard merely because it has JavaScript. Choose by purpose and lifecycle, not implementation complexity.

## Authoring

`preview` accepts an HTML/CSS/JavaScript bundle:

- `html` supplies the document body or a complete HTML document.
- `css` supplies preview-specific styling.
- `js` supplies preview-specific behavior and interaction.

The renderer isolates the bundle in a sandbox and lays it out against a 16:9 inline viewport. The visible host frame hugs shorter document content instead of reserving an empty 16:9 tail; content that reaches or exceeds the 16:9 viewport remains bounded by that viewport and scrolls internally. Use `get_visualization_width` when the available inline width materially affects the design; derive the maximum preview height from that width at 16:9.

Treat the bundle as disposable inspection output. If the user wants the work persisted or edited as a real file, use the workspace/artifact workflow instead; if they want a persistent control surface, use Dashboard.
