---
name: visualization
description: Guidance for quick inline visualization in Vulcan. Read this when a visual answer, diagram, layout, flow, or conversational sketch would communicate an idea faster or more clearly than prose.
---

# Visualization

A visualization is a quick, demonstrative visual answer rendered inline as part of the conversation. Treat it like a whiteboard sketch: elective, casual, and communicative. Reach for it when showing something carries the idea better than describing it.

## When to sketch

Some things have shape. Data moving through a system, components fitting together, relationships, comparisons, or an idea taking form can be easier to understand visually. When the picture would do more work than the words, sketch it.

Visualization can be proactive: if a small visual would materially improve the answer, you may choose to use one without the user explicitly requesting it. Keep that choice proportional; ordinary prose does not need decoration.

## Visualization vs. preview

Choose by purpose, not file type.

- **Visualization** communicates an idea in the conversation. It is quick, demonstrative, elective, and disposable.
- **Preview** externalizes a concrete interpretation of prospective interface or frontend work so the user can react to it and sharpen what should be built. It is preparatory, intentional, and uses an HTML/CSS/JavaScript bundle.

A rough UI sketch can be a visualization when the sketch itself is the conversational explanation. If a concrete candidate would help the user confirm, correct, or sharpen what a page, component, interface, or interaction should become, use `preview` instead.

## Visualization vs. dashboard

Dashboards live in the sidebar and persist. Visualizations live in the chat and are part of the response. If it is a visual answer, it is a visualization. If it is a persistent control surface or live data view the user will interact with between messages, it is a Dashboard.

## Output types

`visualize` accepts SVG, HTML, or Mermaid. Pick the lightweight representation that fits the conversational visual:

- **SVG** — diagrams, flows, architecture sketches, spatial layouts, precise positioning.
- **HTML** — richer conversational layouts or comparisons where markup is convenient; do not use Visualization HTML as a substitute for a Preview whose purpose is to shape prospective work.
- **Mermaid** — sequence diagrams, entity relationships, simple flowcharts where structure is the point.

Use `get_visualization_width` before rendering anything layout-sensitive.

## Quality

Keep the visual focused on the point it is communicating. Labels should be legible and complexity should earn its place. A simple visual that lands is better than an elaborate one that becomes a side project.
