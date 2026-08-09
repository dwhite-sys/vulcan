---
name: tool-discovery
description: Guidance for navigating the Etna kit and skill system. Read this when you're about to search for a tool and aren't sure of the most efficient path, when a task might have a purpose-built kit you haven't used before, or when you want to understand what's available without burning unnecessary turns finding out.
---

# Tool Discovery

Etna organizes capabilities into kits (branches) and tools (leaves). You don't need to know the full tree to work effectively — you need to know how to navigate it efficiently when the task calls for it.

## When to look

The terminal is always there. Before reaching for it, ask whether the task has a shape that suggests a purpose-built tool exists — an API client, a notification sender, a browser automation kit. If the answer is maybe, search. If the answer is clearly no, proceed.

Don't inventory everything before starting. One targeted search when you have a hunch is the right move. Browsing the full kit landscape speculatively burns turns and context without adding much.

## Navigating the tree

**When you have a hunch something exists:**
```
search_tools({ query: "keyword" })
```
Keyword search across all tool names and descriptions. Search on the hunch. If something looks promising, inspect it before calling.

**When a search returns a hit worth examining:**
```
inspect_tool({ tool: "exact_tool_name" })
```
Full schema — parameters, types, which kit it lives in. Confirms exactly how to call it before you commit. Only works with names returned by `search_tools`.

**When you want to understand a kit before using it:**
```
inspect_kit({ kit: "Kit Name" })
```
Kit description, tool count, and whether a skill is attached. One level above the tools — tells you if the kit is worth going deeper into, and whether there's guidance worth reading before you do.

**When you need the full landscape:**
```
list_kits
```
All available kits at once. Not the move for finding something specific — use this when understanding the whole kit space is itself what you need.

## Skills

Vulcan's built-in skill names and descriptions are already present in your system context, so reach directly for those with `read_skill` when their description matches the work in front of you.

Etna skills are dynamic. Use `list_skills` for the available set or `search_skills` when you have a keyword-level hunch. Results include a `source`: standalone Etna skills use `skills`, kit-paired skills use `kits/<kit-stem>`, and Vulcan's own skills use `vulcan` in the unified interface.

`inspect_kit` also tells you when an enabled kit has a paired skill and gives you its source. Once you know the skill, the same file protocol applies regardless of source:

```
read_skill({ skill: "skill-name", source: "skills" })
list_skill_files({ skill: "skill-name", source: "skills" })
read_skill_file({ skill: "skill-name", source: "skills", file: "references/details.md" })
```

Read bundled resources only when SKILL.md points to them or they materially affect the task. Read the relevant skill before you start, not after something goes sideways.

## Efficiency

Don't re-discover what you already know. If you searched for something earlier in the conversation, that information is still in context — don't repeat the search.

Don't call `inspect_kit` speculatively on every kit. Search first, inspect when you have a reason to.

If `inspect_kit` surfaces a skill, that's the fastest path into using the kit well — reading it costs one turn and saves several.

A kit you've confirmed as relevant is yours to use for the rest of the session. No need to re-list its tools on every turn.
