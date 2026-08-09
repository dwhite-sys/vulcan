/**
 * vulcanTools.ts — Always-visible Vulcan built-in tools injected into every conversation.
 *
 * These are intercepted by the client before any tool call reaches Vulcan.
 * Workspace tools (present, run_command, etc.) are only included when
 * cliWorkspaceEnabled is true.
 *
 * STUB: Most of these delegate to Vulcan stubs. Real implementations
 * will be wired up when Vulcan is built.
 */

import type { Tool } from '../types/vulcan';
import { vulcanClient } from './vulcanClient';
import * as vulcan from './vulcan';
import {
  listAvailableSkills,
  searchAvailableSkills,
  readAvailableSkill,
  listAvailableSkillFiles,
  readAvailableSkillFile,
} from './skillService';

// ── Tool schemas ──────────────────────────────────────────────────────────────

const DISCOVERY_TOOLS: Tool[] = [
  {
    name: 'list_kits',
    description: "Surface an overview of all available kits at once. Not the first move for finding a tool — search_tools handles that. Use this when a bird's-eye view of the whole kit landscape is itself what you need.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'inspect_kit',
    description: "Check what a kit is and whether it has a skill before going deeper. One level above the tools — tells you if this branch is worth walking down, and if there's a skill that may be worth reading before you do.",
    parameters: {
      type: 'object',
      properties: { kit: { type: 'string', description: 'Kit name' } },
      required: ['kit'],
    },
  },
  {
    name: 'search_tools',
    description: "Search across available tools by keyword. Reach for this when you have a hunch something exists that's more direct than the terminal for this particular job — a dedicated tool rather than a raw command. Search on the hunch, inspect when you get a hit.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'inspect_tool',
    description: "Inspect a tool's full schema — parameters, types, which kit it lives in. The move after a good search hit, to confirm exactly how to call it before you commit. Only works with names returned by search_tools.",
    parameters: {
      type: 'object',
      properties: { tool: { type: 'string', description: 'Exact tool function name as returned by search_tools' } },
      required: ['tool'],
    },
  },
 ];

const SKILL_TOOLS: Tool[] = [
  {
    name: 'list_skills',
    description: "List the skills currently available in this chat across Vulcan and Etna. Each skill includes its source: 'vulcan', 'skills', or 'kits/<kit-stem>'. Vulcan's built-in skill metadata is already present in system context, so this is most useful for discovering dynamic Etna skills.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_skills',
    description: "Search available skill names and descriptions by keyword across both Vulcan and Etna. Use this when you suspect a specialized procedural reference may exist but don't know its exact name.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keyword search query' } },
      required: ['query'],
    },
  },
  {
    name: 'read_skill',
    description: "Read a skill's SKILL.md body. Skills are directory-backed packages regardless of whether they come from Vulcan or Etna; use list_skill_files/read_skill_file when the skill points to bundled resources.",
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact skill name from system context, list_skills/search_skills, or inspect_kit' },
        source: { type: 'string', description: "Optional source to disambiguate duplicate names: 'vulcan', 'skills', or 'kits/<kit-stem>'" },
      },
      required: ['skill'],
    },
  },
  {
    name: 'list_skill_files',
    description: "List every file bundled with a skill package. Paths are relative to the skill root and SKILL.md is listed first.",
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact skill name' },
        source: { type: 'string', description: 'Optional source to disambiguate duplicate names' },
      },
      required: ['skill'],
    },
  },
  {
    name: 'read_skill_file',
    description: "Read a bundled file from a skill package using a path returned by list_skill_files. Text files are returned as text; binary files are returned as base64 with their content type.",
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact skill name' },
        file: { type: 'string', description: 'Path relative to the skill root' },
        source: { type: 'string', description: 'Optional source to disambiguate duplicate names' },
      },
      required: ['skill', 'file'],
    },
  },
];

const USER_INTERACTION_TOOLS: Tool[] = [
  {
    name: 'ask_user',
    description: "Ask the user one question when their input is needed before continuing. Provide concise suggested answers when useful. Prefer no more than 4 answer options. A maximum of 5 options is supported; any options beyond the first 5 will be discarded by Vulcan. For multiple independent questions, call this tool multiple times in the same response; Vulcan will present simultaneous calls together. If a later question depends on an earlier answer, wait for the answer before asking the follow-up. Do not provide 'Something else' or 'Skip' as options; Vulcan provides those automatically.",
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user.' },
        options: {
          type: 'array',
          description: 'Suggested answers the user can select. Prefer 2–4 concise options. Maximum 5; additional options will be discarded.',
          items: { type: 'string' },
          maxItems: 5,
        },
      },
      required: ['question', 'options'],
    },
  },
];

const RENDER_TOOLS: Tool[] = [
  {
    name: 'visualize',
    description: "Show rather than tell. Sketch what's taking shape in the conversation — a layout, a flow, a diagram — rather than merely describing it back in prose. Some things have shape: data moving through a system, components fitting together, a UI taking form. When the picture would do more work than the words, sketch it. The visualization skill goes deeper if you're unsure which output type fits or want guidance on getting it right.",
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The SVG, HTML, or Mermaid source to render' },
        type: { type: 'string', enum: ['svg', 'html', 'mermaid'], description: 'Content type (default: svg)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'get_visualization_width',
    description: "Returns the current pixel width of the inline visualization area. Call this before rendering anything layout-sensitive — charts, multi-column layouts, anything where the available width would change how you design it.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_dashboard',
    description: "Open a finished dashboard in the user's workspace. Call this when you're satisfied with what you've built — it's the moment you hand it to them. Build with dashboard_create, refine with dashboard_update if needed, and open it when it's ready. The dashboard-authoring skill goes deeper if you want guidance on building something polished.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The panel name to present.' },
      },
      required: ['name'],
    },
  },
];

const WORKSPACE_TOOLS: Tool[] = [
  {
    name: 'present',
    description: "Surface a file to the user — opens it in the workspace editor and adds it to the Artifacts list. Use this when you've created or changed something worth showing: a finished script, a generated report, a config the user needs to review.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file within /workspace' } },
      required: ['path'],
    },
  },
  {
    name: 'view_file',
    description: "Read a file from the workspace into context. Reach for this when you need to see what's in a file without it being worth opening a terminal — a quick read before editing, checking a config, understanding what's there. For binary files or anything you need to process with code, use the terminal instead.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file within /workspace' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: "Run a shell command in the focused agent terminal. The shell is stateful — working directory and environment carry forward between commands. Output is returned when the command finishes or times out.",
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to run' },
        timeout: { type: 'number', description: 'Timeout in seconds before the command is detached (default: 180)' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'send_input',
    description: "Send text to the focused terminal's stdin. Use this for interactive processes that are waiting for input — a prompt, a confirmation, a REPL.",
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to send to the terminal stdin' },
      },
      required: ['text'],
    },
  },
  {
    name: 'kill_process',
    description: "Terminate the running process in the focused terminal.",
    parameters: {
      type: 'object',
      properties: { pid: { type: 'string', description: 'Process ID returned by run_command' } },
      required: ['pid'],
    },
  },
  {
    name: 'wait',
    description: "Pause for a specified number of seconds before the next step.",
    parameters: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Number of seconds to wait' } },
      required: ['seconds'],
    },
  },
  {
    name: 'open_terminal',
    description: "Open an additional agent terminal when something needs to run alongside something else — a server in one terminal, work in another. Returns the slot number. If you're not sure what's already open, check with list_terminals first. Call switch_terminal before using it.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'close_terminal',
    description: "Close an agent terminal and kill anything running in it. Use this when the work a terminal was opened for is done. Omit slot to close the currently focused one.",
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'number', description: 'Terminal slot to close (1-3). Omit to close the focused terminal.' },
      },
      required: [],
    },
  },
  {
    name: 'switch_terminal',
    description: "Select which terminal subsequent commands run in. Call this after open_terminal, or to move between slots when managing parallel work.",
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'number', description: 'Terminal slot to switch to (1-3)' },
      },
      required: ['slot'],
    },
  },
  {
    name: 'read_output',
    description: "Read recent output from a terminal without switching focus. Use this to check on a running process — a server, a long install, a background job — without interrupting what you're doing in another slot.",
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Number of lines to read (default: 50)' },
        slot: { type: 'number', description: 'Terminal slot to read from (1-3). Omit to read from the focused terminal.' },
      },
      required: [],
    },
  },
  {
    name: 'list_terminals',
    description: "List currently open agent terminal slots and their state. Check this when you're not sure what's already open before deciding whether to open a new terminal.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_in_file',
    description: "Search a file for a string and get back every matching line with its line number. Use this to locate something before editing it, or to verify placement after. Returns [{line, content}] — exact line numbers you can use directly in an edit call.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file within /workspace' },
        query: { type: 'string', description: 'Exact string to search for' },
      },
      required: ['path', 'query'],
    },
  },
  {
    name: 'edit',
    description: "Make one or more targeted changes to a workspace file without rewriting it entirely. Pass an array of edits — each with a line range, an anchor string that proves you read the current content, and the replacement. Edits are applied top-to-bottom with line numbers adjusted between each, so batching multiple changes in one call is safe. Each edit returns its new line range so you know where things landed.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file within /workspace' },
        edits: {
          type: 'array',
          description: 'Anchored line-range replacements, expressed against the current file before this edit call.',
          items: {
            type: 'object',
            properties: {
              start_line: { type: 'number', description: 'First line of the range (1-indexed, inclusive)' },
              end_line: { type: 'number', description: 'Last line of the range (1-indexed, inclusive)' },
              anchor: { type: 'string', description: 'Distinctive text that must occur somewhere inside this range' },
              replacement: { type: 'string', description: 'Replacement content for the range' },
            },
            required: ['start_line', 'end_line', 'anchor', 'replacement'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
];

function makePanelTools(chatId: string): Tool[] {
  return [
  {
    name: 'dashboard_create',
    description: "Create a dashboard in the user's workspace. Reach for this when there's something worth controlling or monitoring — an API, a database, a running process. Build it right the first time: functional, clean, something the user would actually reach for. The dashboard-authoring skill has what you need for non-trivial builds — container proxying, live data, and dashboard structure. Update with dashboard_update, hand it off with open_dashboard.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique panel name within this chat' },
        html: { type: 'string', description: 'HTML body content' },
        css: { type: 'string', description: 'CSS styles (injected into <head>)' },
        js: { type: 'string', description: 'JavaScript (injected before </body>)' },
      },
      required: ['name', 'html'],
    },
  },
  {
    name: 'dashboard_update',
    description: "Refine a dashboard by replacing one or more parts — html, css, or js — without rebuilding the whole thing. Faster and cleaner than scrapping it and starting fresh. Inspect first if you need to see what's currently there. The dashboard-authoring skill goes deeper if you're unsure how to approach a non-trivial change.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Dashboard name to update' },
        part: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which part to replace' },
        content: { type: 'string', description: 'New content for this part' },
      },
      required: ['name', 'part', 'content'],
    },
  },
  {
    name: 'dashboard_inspect',
    description: "Check what's currently in a dashboard part before editing. Use this to make sure you know exactly what you're changing.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Dashboard name to inspect' },
        part: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which part to read' },
      },
      required: ['name', 'part'],
    },
  },
  {
    name: 'dashboard_list',
    description: "See what dashboards exist in this chat and when they were last updated.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dashboard_delete',
    description: "Delete a dashboard. Can't be undone.",
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Dashboard name to delete' } },
      required: ['name'],
    },
  },
  ];
}

// ── Tool list builder ─────────────────────────────────────────────────────────

export function getVulcanTools(cliWorkspaceEnabled: boolean, toolMode: 'broad' | 'search' = 'broad', panelsEnabled: boolean = true, chatId: string = ''): Tool[] {
  return [
    ...(toolMode === 'search' ? DISCOVERY_TOOLS : []),
    ...SKILL_TOOLS,
    ...USER_INTERACTION_TOOLS,
    ...RENDER_TOOLS,
    ...(cliWorkspaceEnabled ? WORKSPACE_TOOLS : []),
    ...(panelsEnabled ? makePanelTools(chatId) : []),
  ];
}

export function isVulcanTool(toolName: string): boolean {
  const all = [...DISCOVERY_TOOLS, ...SKILL_TOOLS, ...USER_INTERACTION_TOOLS, ...RENDER_TOOLS, ...WORKSPACE_TOOLS, ...makePanelTools('')];
  return all.some((t) => t.name === toolName);
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export interface VulcanToolContext {
  chatId: string;
  cliWorkspaceEnabled: boolean;
  getRenderWidth: () => number;
  onPresent: (path: string) => void;
  onPanel: (name: string, html: string, css?: string, js?: string) => void;
  onPanelDelete: (name: string) => void;
  onTerminalStream?: (pid: string, label: string) => void;
  onTerminalDone?: () => void;
  selectedModel: string;
  enabledKits: string[];
  disabledTools: Set<string>;
  kitsWithTools: import('../types/vulcan').KitWithTools[];
  enabledGeneralSkills: { name: string; description?: string; source?: string }[];
  panelsEnabled: boolean;
  // Terminal slot context
  focusedAgentSlot: number | null;                 // explicitly selected agent slot, or null
  openAgentSlots: number[];                        // list of open agent slot numbers
  onOpenAgentSlot: () => Promise<number>;          // opens new slot, returns slot number
  onCloseAgentSlot: (slot: number) => void;
  onSwitchAgentSlot: (slot: number) => void;
}

export async function executeVulcanTool(
  toolName: string,
  args: Record<string, any>,
  ctx: VulcanToolContext,
): Promise<string> {

  // ── Discovery ───────────────────────────────────────────────────────────────

  const skillCtx = {
    settings: {
      cliWorkspaceEnabled: ctx.cliWorkspaceEnabled,
      panelsEnabled: ctx.panelsEnabled,
    },
    enabledGeneralSkills: ctx.enabledGeneralSkills,
    enabledKits: ctx.enabledKits,
  };

  if (toolName === 'list_skills') {
    try {
      return JSON.stringify({ skills: await listAvailableSkills(skillCtx) });
    } catch {
      return JSON.stringify({ error: 'Failed to list skills' });
    }
  }

  if (toolName === 'search_skills') {
    const query = String(args.query ?? '').trim();
    if (!query) return JSON.stringify({ error: 'search_skills requires a query' });
    try {
      const results = await searchAvailableSkills(query, skillCtx);
      return JSON.stringify({ results });
    } catch {
      return JSON.stringify({ error: 'Failed to search skills' });
    }
  }

  if (toolName === 'read_skill') {
    const skillName = String(args.skill ?? '').trim();
    const source = args.source ? String(args.source).trim() : undefined;
    if (!skillName) return JSON.stringify({ error: 'read_skill requires an exact skill name' });
    try {
      const skill = await readAvailableSkill(skillName, source, skillCtx);
      return JSON.stringify({
        ...skill,
        guidance: 'This skill is a procedural reference, not an added capability. Apply the instructions that materially affect the current task. When SKILL.md points to bundled resources, inspect them with list_skill_files/read_skill_file as needed. Once its relevant guidance is in context, do not reload this skill unnecessarily.',
      });
    } catch (error: any) {
      return JSON.stringify({ error: error?.message ?? `Skill '${skillName}' could not be read` });
    }
  }

  if (toolName === 'list_skill_files') {
    const skillName = String(args.skill ?? '').trim();
    const source = args.source ? String(args.source).trim() : undefined;
    if (!skillName) return JSON.stringify({ error: 'list_skill_files requires an exact skill name' });
    try {
      return JSON.stringify(await listAvailableSkillFiles(skillName, source, skillCtx));
    } catch (error: any) {
      return JSON.stringify({ error: error?.message ?? `Could not list files for skill '${skillName}'` });
    }
  }

  if (toolName === 'read_skill_file') {
    const skillName = String(args.skill ?? '').trim();
    const file = String(args.file ?? '').trim();
    const source = args.source ? String(args.source).trim() : undefined;
    if (!skillName || !file) return JSON.stringify({ error: 'read_skill_file requires skill and file' });
    try {
      return JSON.stringify(await readAvailableSkillFile(skillName, file, source, skillCtx));
    } catch (error: any) {
      return JSON.stringify({ error: error?.message ?? `Could not read '${file}' from skill '${skillName}'` });
    }
  }

  if (toolName === 'list_kits') {
    try {
      const kits = await vulcanClient.listKits();
      // Only expose kits that are enabled for this chat
      const visible = kits.filter((k) => ctx.enabledKits.includes(k));
      return JSON.stringify({ kits: visible });
    } catch {
      return JSON.stringify({ error: 'Failed to list kits' });
    }
  }

  if (toolName === 'inspect_kit') {
    // Block access to kits not enabled for this chat
    if (!ctx.enabledKits.includes(args.kit)) {
      return JSON.stringify({ error: `Kit '${args.kit}' not found` });
    }
    try {
      const kit: any = await vulcanClient.inspectKit(args.kit);
      if (kit.skill) {
        let skillName: string | null = null;
        try {
          const skillMeta = (await vulcanClient.listSkills()).find((skill) => skill.source === kit.skill);
          skillName = skillMeta?.name ?? null;
        } catch { /* metadata lookup is advisory */ }
        return JSON.stringify({
          ...kit,
          has_skill: true,
          skill_name: skillName,
          skill_guidance: skillName
            ? `This kit includes the skill '${skillName}' from source '${kit.skill}'. Read it with read_skill({ skill: '${skillName}', source: '${kit.skill}' }) when its instructions are likely to materially affect how you use the kit.`
            : `This kit includes a skill from source '${kit.skill}'. Use list_skills to resolve its name before reading it.`,
        });
      }
      return JSON.stringify({ ...kit, has_skill: false, skill: null });
    } catch {
      return JSON.stringify({ error: `Kit '${args.kit}' not found` });
    }
  }

  if (toolName === 'search_tools') {
    const query = (args.query ?? '').toLowerCase().trim();
    if (!query) return JSON.stringify({ results: [] });

    const terms = query.split(/\s+/);

    const matches: { kit: string; tool: string; description: string }[] = [];

    for (const kit of ctx.kitsWithTools) {
      if (!ctx.enabledKits.includes(kit.kit_name)) continue;
      for (const tool of kit.tools) {
        if (ctx.disabledTools.has(`${kit.kit_name}::${tool.name}`)) continue;

        // Build a searchable blob: tool name, description, param names + descriptions
        const paramText = Object.entries(tool.parameters?.properties ?? {})
          .map(([k, v]) => `${k} ${(v as any).description ?? ''}`)
          .join(' ');
        const blob = `${tool.name} ${tool.description} ${paramText}`.toLowerCase();

        // All terms must appear somewhere in the blob
        if (terms.every((t) => blob.includes(t))) {
          matches.push({ kit: kit.kit_name, tool: tool.name, description: tool.description });
        }
      }
    }

    return JSON.stringify({ results: matches });
  }

  if (toolName === 'inspect_tool') {
    const toolName_ = args.tool;
    if (!toolName_) return JSON.stringify({ error: 'inspect_tool requires a tool name' });

    for (const kit of ctx.kitsWithTools) {
      if (!ctx.enabledKits.includes(kit.kit_name)) continue;
      const tool = kit.tools.find((t) => t.name === toolName_);
      if (!tool) continue;
      if (ctx.disabledTools.has(`${kit.kit_name}::${tool.name}`)) {
        return JSON.stringify({ error: `Tool '${toolName_}' is disabled` });
      }
      return JSON.stringify({
        kit: kit.kit_name,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
    return JSON.stringify({ error: `Tool '${toolName_}' not found. Use search_tools to find the correct name.` });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (toolName === 'visualize') {
    // Client handles rendering — just return success so the model knows it worked
    return JSON.stringify({ ok: true, type: args.type ?? 'svg' });
  }

  if (toolName === 'get_visualization_width') {
    return JSON.stringify({ width: ctx.getRenderWidth() });
  }

  if (toolName === 'open_dashboard') {
    const { name } = args;
    if (!name) return JSON.stringify({ error: 'open_dashboard requires name' });
    // Signal the UI to surface this panel in the chat and open it in the workspace
    ctx.onPanel(name, '', '', '');
    return JSON.stringify({ ok: true, name });
  }

  if (toolName === 'dashboard_create') {
    const { name, html, css = '', js = '' } = args;
    if (!name || !html) return JSON.stringify({ error: 'dashboard_create requires name and html' });
    try {
      await vulcan.dashboardCreate(ctx.chatId, name, html, css, js);
      ctx.onPanel(name, html, css, js);
      return JSON.stringify({ ok: true, name });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  if (toolName === 'dashboard_update') {
    const { name, part, content } = args;
    if (!name || !part || content === undefined) return JSON.stringify({ error: 'dashboard_update requires name, part, and content' });
    try {
      await vulcan.dashboardUpdate(ctx.chatId, name, part, content);
      ctx.onPanel(name, '', '', ''); // signal update — WorkspacePanel will refetch
      return JSON.stringify({ ok: true, name, part });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  if (toolName === 'dashboard_inspect') {
    const { name, part } = args;
    if (!name || !part) return JSON.stringify({ error: 'dashboard_inspect requires name and part' });
    try {
      const content = await vulcan.dashboardInspect(ctx.chatId, name, part);
      return JSON.stringify({ content });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  if (toolName === 'dashboard_list') {
    try {
      const panels = await vulcan.dashboardList(ctx.chatId);
      return JSON.stringify({ dashboards: panels });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  if (toolName === 'dashboard_delete') {
    const { name } = args;
    if (!name) return JSON.stringify({ error: 'dashboard_delete requires name' });
    try {
      await vulcan.dashboardDelete(ctx.chatId, name);
      ctx.onPanelDelete(name);
      return JSON.stringify({ ok: true, name });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  // ── Workspace (CLI only) ────────────────────────────────────────────────────

  if (!ctx.cliWorkspaceEnabled) {
    return JSON.stringify({ error: 'CLI workspace is not enabled' });
  }

  // Inside bwrap the agent's root is /workspace, so it naturally passes absolute
  // paths like /workspace/report.md. Strip that prefix so Vulcan receives a path
  // relative to the chat workspace dir, which is what it expects.
  const toRelative = (p: string) => p.replace(/^\/workspace\//, '');

  if (toolName === 'present') {
    const relPath = toRelative(args.path);
    await vulcan.presentFile(ctx.chatId, relPath);
    ctx.onPresent(relPath);
    return JSON.stringify({ ok: true, path: relPath });
  }

  if (toolName === 'view_file') {
    // STUB: Vulcan reads file bytes and returns base64 + mime type
    // TODO: GET /workspace/file/base64?chat_id=chatId&path=path → { base64: string, mimeType: string }
    // For images on vision-capable models, we return a special marker that the inference
    // loop intercepts and injects as a synthetic [System] user message with an image_url block.
    // For PDFs, Vulcan would extract text and return it as a string result.
    // For unsupported types, return an error.
    console.warn('[VULCAN STUB] view_file', { chatId: ctx.chatId, path: args.path });

    // Detect file type from extension
    const ext = toRelative(args.path as string).split('.').pop()?.toLowerCase() ?? '';
    args = { ...args, path: toRelative(args.path) };
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

    if (imageExts.includes(ext)) {
      // TODO: check ctx.selectedModel modalities for vision support
      // For now, assume vision capable if model name contains common vision model identifiers
      const modelLower = ctx.selectedModel.toLowerCase();
      const likelyHasVision = modelLower.includes('vision') || modelLower.includes('gpt-4') ||
        modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('4o');

      if (!likelyHasVision) {
        return JSON.stringify({ error: 'This model does not appear to support image viewing. Use the terminal to inspect the file instead.' });
      }

      // Return special marker — inference loop will inject synthetic [System] user message
      let dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,`;
      try {
        const { base64 } = await vulcan.readFileBase64(ctx.chatId, args.path);
        dataUrl += base64;
      } catch {
        return JSON.stringify({ error: `Could not read file: ${args.path}` });
      }
      const filename = (args.path as string).split('/').pop() ?? args.path;
      return JSON.stringify({ __view_file_image__: true, dataUrl, filename, ok: true });
    }

    if (ext === 'pdf') {
      // TODO: POST /workspace/file/extract-text { chat_id, path } → { text: string }
      return JSON.stringify({ error: 'PDF text extraction not yet implemented — Vulcan required' });
    }

    // Fallback: treat as plain text — covers .py, .md, .ts, .json, .txt, etc.
    try {
      const content = await vulcan.readFile(ctx.chatId, args.path);
      return JSON.stringify({ content });
    } catch {
      return JSON.stringify({ error: `Could not read file: ${args.path}` });
    }
  }

  if (toolName === 'run_command') {
    if (ctx.focusedAgentSlot === null) {
      return JSON.stringify({ error: 'No agent terminal is selected. Call open_terminal, then switch_terminal with the returned slot before using run_command.' });
    }
    const pid = await vulcan.runCommandInSlot(
      ctx.chatId,
      'agent',
      ctx.focusedAgentSlot,
      args.cmd,
      args.timeout ?? 180,
    );

    ctx.onTerminalStream?.(pid, args.cmd);
    const result = await vulcan.waitForResult(pid, ((args.timeout ?? 180) + 5) * 1000);
    ctx.onTerminalDone?.();

    const output = result.output?.trim() || '(no output)';
    if (result.detached) {
      const reason = result.detach_reason?.trim();
      return JSON.stringify({ output, detached: true, note: reason ? `Detached by user. Reason: ${reason}` : 'Detached by user.' });
    }
    return JSON.stringify({ output, exit_code: result.exit_code ?? 0 });
  }

  if (toolName === 'send_input') {
    if (ctx.focusedAgentSlot === null) {
      return JSON.stringify({ error: 'No agent terminal is selected. Call switch_terminal before using send_input.' });
    }
    const ok = await vulcan.sendSlotInput(ctx.chatId, 'agent', ctx.focusedAgentSlot, args.text);
    return JSON.stringify({ ok });
  }

  if (toolName === 'kill_process') {
    const ok = await vulcan.killProcess(args.pid);
    ctx.onTerminalDone?.();
    return JSON.stringify({ ok });
  }

  if (toolName === 'open_terminal') {
    try {
      const slot = await ctx.onOpenAgentSlot();
      return JSON.stringify({ ok: true, slot, note: `Opened agent terminal ${slot}. Call switch_terminal(${slot}) before running commands in it.` });
    } catch (e: any) {
      return JSON.stringify({ error: e.message ?? 'Failed to open terminal' });
    }
  }

  if (toolName === 'close_terminal') {
    const slot = args.slot ?? ctx.focusedAgentSlot;
    if (slot === null) {
      return JSON.stringify({ error: 'No terminal selected. Specify a slot explicitly or call switch_terminal first.' });
    }
    ctx.onCloseAgentSlot(slot);
    return JSON.stringify({ ok: true, slot });
  }

  if (toolName === 'switch_terminal') {
    const slot = args.slot;
    if (!ctx.openAgentSlots.includes(slot)) {
      return JSON.stringify({ error: `Terminal ${slot} is not open. Open slots: ${ctx.openAgentSlots.join(', ') || 'none'}` });
    }
    ctx.onSwitchAgentSlot(slot);
    return JSON.stringify({ ok: true, slot, note: `Switched focus to terminal ${slot}.` });
  }

  if (toolName === 'read_output') {
    const slot = args.slot ?? ctx.focusedAgentSlot;
    if (slot === null) {
      return JSON.stringify({ error: 'No terminal selected. Specify a slot explicitly or call switch_terminal first.' });
    }
    const lines = args.lines ?? 50;
    try {
      const output = await vulcan.readSlotOutput(ctx.chatId, 'agent', slot, lines);
      return JSON.stringify({ output, slot, lines });
    } catch {
      return JSON.stringify({ error: `Could not read output from terminal ${slot}` });
    }
  }

  if (toolName === 'wait') {
    const pid = await vulcan.startWait(ctx.chatId, args.seconds ?? 5);
    ctx.onTerminalStream?.(pid, `wait(${args.seconds ?? 5}s)`);
    const result = await vulcan.waitForResult(pid, ((args.seconds ?? 5) + 5) * 1000);
    ctx.onTerminalDone?.();
    if (result.detached) {
      const reason = result.detach_reason?.trim();
      return JSON.stringify({ detached: true, note: reason ? `Detached by user. Reason: ${reason}` : 'Detached by user.' });
    }
    return JSON.stringify({ ok: true, waited: args.seconds ?? 5 });
  }

  if (toolName === 'list_terminals') {
    try {
      const slots = await vulcan.listSlots(ctx.chatId);
      const terminals = slots
        .filter((slot) => slot.kind === 'agent' && !slot.finished)
        .map((slot) => ({ slot: slot.slot, state: slot.has_running ? 'running' : 'idle', focused: slot.slot === ctx.focusedAgentSlot }));
      return JSON.stringify({ terminals });
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  if (toolName === 'find_in_file') {
    const path = String(args.path ?? '');
    const query = String(args.query ?? '');
    if (!path || !query) return JSON.stringify({ error: 'find_in_file requires path and query' });
    try {
      const matches = await vulcan.findInFile(ctx.chatId, toRelative(path), query);
      return JSON.stringify(matches);
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  if (toolName === 'edit') {
    const path = String(args.path ?? '');
    const edits = Array.isArray(args.edits) ? args.edits : null;
    if (!path || !edits?.length) return JSON.stringify({ error: 'edit requires path and a non-empty edits array' });
    try {
      const result = await vulcan.editFile(ctx.chatId, toRelative(path), edits.map((edit: any) => ({
        start_line: Number(edit.start_line),
        end_line: Number(edit.end_line),
        anchor: String(edit.anchor ?? ''),
        replacement: String(edit.replacement ?? ''),
      })));
      return JSON.stringify(result);
    } catch (e: any) {
      return JSON.stringify({ error: e?.message ?? String(e) });
    }
  }

  return JSON.stringify({ error: `Unknown Vulcan tool: ${toolName}` });
}
