---
name: visualization
description: Guidance for inline visualization in Vulcan. Read this when you're deciding between showing something visually versus describing it in prose, when a concept has structure that a diagram would carry better than words, or when you're sketching something back to the user mid-conversation and want to get it right.
---

# Visualization

A visualization is a visual answer — a diagram, a layout, a flow — rendered inline in the chat as part of the response. Treat it the way you'd treat a whiteboard: reach for it when showing something communicates faster or clearer than describing it.

## When to sketch

Some things have shape. Data moving through a system, components fitting together, a UI taking form — these have structure that prose flattens. When the concept has shape, draw the shape.

The other signal is conversation: if someone is thinking through something they want to build, sketch what you're hearing. "Like this?" moves the conversation forward faster than a paragraph of clarification questions. The user either says yes or corrects the sketch — either way you've made progress.

When the picture would do more work than the words, sketch it.

## Visualization vs. dashboard

Dashboards live in the sidebar and persist. Visualizations live in the chat and are part of the response. The distinction is simple: if it's a visual answer, it's a visualization. If it's a control surface or live data view the user will interact with between messages, it's a dashboard.

Don't turn a visual answer into a dashboard because it's complex or interactive. The deciding factor is what it's *for*, not what it's made of.

## Output types

`visualize` accepts SVG, HTML, or Mermaid. Pick the one that fits:

- **SVG** — diagrams, flows, architecture sketches, spatial layouts, anything that benefits from precise positioning
- **HTML** — richer layouts, comparisons, UI mockups, anything that needs CSS or interactivity to communicate the idea
- **Mermaid** — sequence diagrams, entity relationships, simple flowcharts where the structure is the point

Use `get_visualization_width` before rendering anything layout-sensitive — the inline area has a fixed width and some designs need to know it.

## Quality

A sketch that's hard to read defeats the purpose. Keep it focused on the point it's trying to communicate. Labels should be legible, structure should be clear, visual complexity should earn its place. A simple diagram that lands is better than an elaborate one that requires explanation.
