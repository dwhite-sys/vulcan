// Vulcan API Client Service

import type { Kit, Tool, ToolResult } from '../types/vulcan';

export interface SkillDescriptor {
  name: string;
  description: string;
  source: string;
}

export type SkillFileResult =
  | { skill: string; file: string; content: string; binary?: false }
  | { skill: string; file: string; binary: true; contentType: string; base64: string };


export class VulcanClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8467') {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  async listKits(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/list_kits`);
    if (!res.ok) throw new Error(`Failed to list kits: ${res.statusText}`);
    const data = await res.json();
    return data.kits || [];
  }

  async inspectKit(kitName: string): Promise<Kit> {
    const res = await fetch(`${this.baseUrl}/inspect_kit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kit: kitName }),
    });
    if (!res.ok) throw new Error(`Failed to inspect kit: ${res.statusText}`);
    return res.json();
  }

  async listToolsInKit(kitName: string): Promise<{ kit: string; tools: Tool[] }> {
    const res = await fetch(`${this.baseUrl}/list_tools_in_kit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kit: kitName }),
    });
    if (!res.ok) throw new Error(`Failed to list tools: ${res.statusText}`);
    return res.json();
  }

  async inspectTool(toolName: string): Promise<Tool & { kit: string }> {
    const res = await fetch(`${this.baseUrl}/inspect_tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName }),
    });
    if (!res.ok) throw new Error(`Failed to inspect tool: ${res.statusText}`);
    return res.json();
  }

  async runTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    const res = await fetch(`${this.baseUrl}/run_tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, arguments: args }),
    });
    if (!res.ok) throw new Error(`Failed to run tool: ${res.statusText}`);
    return res.json();
  }

  async listSkills(): Promise<SkillDescriptor[]> {
    const res = await fetch(`${this.baseUrl}/list_skills`);
    if (!res.ok) throw new Error(`Failed to list skills: ${res.statusText}`);
    const data = await res.json();
    return data.skills || [];
  }

  async searchSkills(query: string): Promise<SkillDescriptor[]> {
    const res = await fetch(`${this.baseUrl}/search_skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Failed to search skills: ${res.statusText}`);
    const data = await res.json();
    return (data.results || []).map((item: any) => ({
      name: item.name || item.skill,
      description: item.description || '',
      source: item.source || 'skills',
    }));
  }

  async readSkill(skillName: string): Promise<{ name: string; body: string }> {
    const res = await fetch(`${this.baseUrl}/read_skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: skillName }),
    });
    if (!res.ok) throw new Error(`Failed to read skill: ${res.statusText}`);
    return res.json();
  }

  async listSkillFiles(skillName: string): Promise<{ skill: string; files: string[] }> {
    const res = await fetch(`${this.baseUrl}/list_skill_files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: skillName }),
    });
    if (!res.ok) throw new Error(`Failed to list skill files: ${res.statusText}`);
    return res.json();
  }

  async readSkillFile(skillName: string, file: string): Promise<SkillFileResult> {
    const res = await fetch(`${this.baseUrl}/read_skill_file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill: skillName, file }),
    });
    if (!res.ok) throw new Error(`Failed to read skill file: ${res.statusText}`);

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    if (contentType.includes('application/json')) return res.json();

    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { skill: skillName, file, binary: true, contentType, base64: btoa(binary) };
  }

  async searchTools(query: string): Promise<{ kit: string; tool: string }[]> {
    const res = await fetch(`${this.baseUrl}/search_tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Failed to search tools: ${res.statusText}`);
    const data = await res.json();
    return data.results || [];
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.listKits();
      return true;
    } catch {
      return false;
    }
  }
}

export const vulcanClient = new VulcanClient();
