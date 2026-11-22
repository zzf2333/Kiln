import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ChatMcpServerItem } from "@kiln/protocol";

export interface DiscoveredSkill {
  name: string;
  description: string;
  skillMdPath: string;
  scope: "project" | "user";
}

export interface ExtensionsDiscoveryOptions {
  projectDir?: string | null;
  kilnHome?: string | null;
  agent?: string | null;
  homeDir?: string;
}

const EXTENSIONS_CACHE_TTL_MS = 15_000;
const EXTENSIONS_CACHE_MAX_ENTRIES = 64;
const MAX_SKILL_BYTES = 32 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SKILLS = 128;
const SAFE_MCP_NAME_RE = /^[a-zA-Z0-9._:-]{1,64}$/;

const skillsCache = new Map<string, { at: number; items: DiscoveredSkill[] }>();
const mcpCache = new Map<string, { at: number; items: ChatMcpServerItem[] }>();

/**
 * Clears in-memory discovery caches for local/project skills and MCP server names.
 */
export function clearExtensionsCache(): void {
  skillsCache.clear();
  mcpCache.clear();
}

function tryCanonicalDir(dirPath: string | null | undefined): string | null {
  if (!dirPath) return null;
  const trimmed = dirPath.trim();
  if (!trimmed) return null;
  try {
    const stat = fs.statSync(trimmed);
    if (!stat.isDirectory()) return null;
    return fs.realpathSync(trimmed);
  } catch {
    return null;
  }
}

function readTextCapped(filePath: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const len = Math.min(stat.size, maxBytes);
    if (len <= 0) return "";
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, 0);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function normalizeDescription(raw: string, fallbackName: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return `技能 ${fallbackName}`;
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

function stripMatchingQuotes(val: string): string {
  const trimmed = val.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillMarkdown(
  raw: string,
  dirName: string,
): { name: string; description: string } {
  let name = dirName;
  let description = "";
  let body = raw;

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (fmMatch) {
    const frontmatter = fmMatch[1] ?? "";
    body = raw.slice(fmMatch[0].length);
    let parsedOk = false;
    try {
      const parsed = parseYaml(frontmatter) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.name === "string" && rec.name.trim()) {
          name = rec.name.trim();
        }
        if (typeof rec.description === "string" && rec.description.trim()) {
          description = rec.description.trim();
        }
        parsedOk = true;
      }
    } catch {
      parsedOk = false;
    }

    if (!parsedOk) {
      const nameMatch = /^name\s*:\s*(.+)$/im.exec(frontmatter);
      if (nameMatch?.[1]) {
        const extracted = stripMatchingQuotes(nameMatch[1]);
        if (extracted) name = extracted;
      }
      const descMatch = /^description\s*:\s*(.+)$/im.exec(frontmatter);
      if (descMatch?.[1]) {
        const extracted = stripMatchingQuotes(descMatch[1]);
        if (extracted && extracted !== "|" && extracted !== ">") {
          description = extracted;
        }
      }
    }
  }

  if (!description) {
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      description = trimmed;
      break;
    }
  }

  const safeName = name.replace(/^\/+/, "").replace(/\s+/g, "-").trim() || dirName;
  return {
    name: safeName,
    description: normalizeDescription(description, safeName),
  };
}

function normalizeAgentFamily(agent: string | null | undefined): string | null {
  const lower = (agent ?? "").trim().toLowerCase();
  if (!lower) return null;
  if (lower.includes("codex")) return "codex";
  if (lower === "pi" || lower.startsWith("pi-") || lower.startsWith("pi/")) return "pi";
  if (lower.includes("antigravity") || lower === "agy") return "antigravity";
  if (lower.includes("claude")) return "claude";
  return null;
}

function resolveAgentSkillDirs(homeDir: string, agent: string | null | undefined): string[] {
  const family = normalizeAgentFamily(agent);
  if (family === "codex") return [path.join(homeDir, ".codex", "skills")];
  if (family === "pi") return [path.join(homeDir, ".pi", "agent", "skills")];
  if (family === "antigravity") return [path.join(homeDir, ".gemini", "antigravity-cli", "skills")];
  if (family === "claude") return [path.join(homeDir, ".claude", "skills")];
  return [
    path.join(homeDir, ".codex", "skills"),
    path.join(homeDir, ".pi", "agent", "skills"),
    path.join(homeDir, ".gemini", "antigravity-cli", "skills"),
    path.join(homeDir, ".claude", "skills"),
  ];
}

function setBoundedCache<T>(
  cache: Map<string, { at: number; items: T[] }>,
  key: string,
  items: T[],
): void {
  if (cache.size >= EXTENSIONS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), items });
}

/**
 * Discovers installed `SKILL.md` skills from project and open/agent standard directories,
 * deduplicating by skill name with project scope overriding user scope.
 */
export function discoverSkills(options: ExtensionsDiscoveryOptions = {}): DiscoveredSkill[] {
  const homeDir = tryCanonicalDir(options.homeDir ?? os.homedir()) ?? path.resolve(options.homeDir ?? os.homedir());
  const projectDir = tryCanonicalDir(options.projectDir);
  const kilnHome = tryCanonicalDir(options.kilnHome);
  const agentFamily = normalizeAgentFamily(options.agent);
  const cacheKey = `${projectDir ?? ""}|${kilnHome ?? ""}|${agentFamily ?? "*"}|${homeDir}`;

  const cached = skillsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EXTENSIONS_CACHE_TTL_MS) {
    return cached.items.map((item) => ({ ...item }));
  }

  const roots: Array<{ dir: string; scope: "project" | "user" }> = [];
  if (projectDir) {
    roots.push(
      { dir: path.join(projectDir, ".agents", "skills"), scope: "project" },
      { dir: path.join(projectDir, ".claude", "skills"), scope: "project" },
      { dir: path.join(projectDir, ".codex", "skills"), scope: "project" },
      { dir: path.join(projectDir, ".gemini", "skills"), scope: "project" },
    );
  }
  if (kilnHome) {
    roots.push({ dir: path.join(kilnHome, "skills"), scope: "user" });
  }
  roots.push({ dir: path.join(homeDir, ".agents", "skills"), scope: "user" });
  for (const agentSkillDir of resolveAgentSkillDirs(homeDir, agentFamily)) {
    roots.push({ dir: agentSkillDir, scope: "user" });
  }

  const seenNames = new Set<string>();
  const collected: DiscoveredSkill[] = [];

  for (const root of roots) {
    if (collected.length >= MAX_SKILLS) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (collected.length >= MAX_SKILLS) break;
      if (entry.name.startsWith(".")) continue;
      const skillDir = path.join(root.dir, entry.name);
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillMdPath = path.join(skillDir, "SKILL.md");
      const raw = readTextCapped(skillMdPath, MAX_SKILL_BYTES);
      if (raw === null) continue;

      const parsed = parseSkillMarkdown(raw, entry.name);
      const dedupeKey = parsed.name.toLowerCase();
      if (seenNames.has(dedupeKey)) continue;
      seenNames.add(dedupeKey);
      collected.push({
        name: parsed.name,
        description: parsed.description,
        skillMdPath,
        scope: root.scope,
      });
    }
  }

  collected.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  setBoundedCache(skillsCache, cacheKey, collected);
  return collected.map((item) => ({ ...item }));
}

function isRecordDisabled(val: unknown): boolean {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const rec = val as Record<string, unknown>;
  return rec.disabled === true || rec.enabled === false;
}

function isValidExternalMcpName(rawName: string): string | null {
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.toLowerCase() === "kiln") return null;
  return SAFE_MCP_NAME_RE.test(trimmed) ? trimmed : null;
}

function extractMcpNamesFromRecord(record: unknown): string[] {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const names: string[] = [];
  for (const [key, cfg] of Object.entries(record as Record<string, unknown>)) {
    if (isRecordDisabled(cfg)) continue;
    const valid = isValidExternalMcpName(key);
    if (valid) names.push(valid);
  }
  return names;
}

function extractMcpNamesFromJson(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const nestedMcp =
    obj.mcp && typeof obj.mcp === "object" && !Array.isArray(obj.mcp)
      ? (obj.mcp as Record<string, unknown>).servers
      : undefined;
  return [
    ...extractMcpNamesFromRecord(obj.mcpServers),
    ...extractMcpNamesFromRecord(nestedMcp),
  ];
}

function extractMcpNamesFromToml(raw: string): string[] {
  const sectionPattern = /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_:-]+))(?:\.[^\]]*)?\]\s*(?:#.*)?$/gm;
  const headers: Array<{ name: string; isRoot: boolean; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(raw)) !== null) {
    const name = match[1] ?? match[2] ?? match[3] ?? "";
    const fullHeader = match[0];
    const isRoot = !/^\s*\[mcp_servers\.(?:"[^"]+"|'[^']+'|[a-zA-Z0-9_:-]+)\./.test(fullHeader);
    headers.push({
      name,
      isRoot,
      start: match.index + match[0].length,
      end: raw.length,
    });
  }

  if (headers.length === 0) return [];
  const anyHeaderPattern = /^\s*\[[^\]]+\]/gm;
  const disabledSet = new Set<string>();
  const candidateNames = new Set<string>();

  for (const h of headers) {
    const valid = isValidExternalMcpName(h.name);
    if (!valid) continue;
    candidateNames.add(valid);
    if (!h.isRoot) continue;
    anyHeaderPattern.lastIndex = h.start;
    const nextHeader = anyHeaderPattern.exec(raw);
    const body = raw.slice(h.start, nextHeader ? nextHeader.index : raw.length);
    if (/^\s*(?:disabled\s*=\s*true|enabled\s*=\s*false)\b/m.test(body)) {
      disabledSet.add(valid.toLowerCase());
    }
  }

  return Array.from(candidateNames).filter((name) => !disabledSet.has(name.toLowerCase()));
}

function extractMcpNamesFromYaml(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const out = new Set<string>();
  for (const name of extractMcpNamesFromRecord(obj.mcpServers)) {
    out.add(name);
  }
  if (Array.isArray(obj.servers)) {
    for (const item of obj.servers) {
      if (typeof item === "string") {
        const valid = isValidExternalMcpName(item);
        if (valid) out.add(valid);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        if (!isRecordDisabled(rec) && typeof rec.name === "string") {
          const valid = isValidExternalMcpName(rec.name);
          if (valid) out.add(valid);
        }
      }
    }
  } else {
    for (const name of extractMcpNamesFromRecord(obj.servers)) {
      out.add(name);
    }
  }
  return Array.from(out);
}

/**
 * Discovers configured external MCP server names (never reading credentials, env, or args)
 * from project, Kiln, and user Agent configuration files.
 */
export function discoverMcpServers(options: ExtensionsDiscoveryOptions = {}): ChatMcpServerItem[] {
  const homeDir = tryCanonicalDir(options.homeDir ?? os.homedir()) ?? path.resolve(options.homeDir ?? os.homedir());
  const projectDir = tryCanonicalDir(options.projectDir);
  const kilnHome = tryCanonicalDir(options.kilnHome);
  const agentFamily = normalizeAgentFamily(options.agent);
  const cacheKey = `${projectDir ?? ""}|${kilnHome ?? ""}|${agentFamily ?? "*"}|${homeDir}`;

  const cached = mcpCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EXTENSIONS_CACHE_TTL_MS) {
    return cached.items.map((item) => ({ ...item }));
  }

  const sources: Array<{
    file: string;
    format: "json" | "toml" | "yaml";
    scope: ChatMcpServerItem["scope"];
    origin: string;
  }> = [];

  if (projectDir) {
    sources.push(
      { file: path.join(projectDir, ".mcp.json"), format: "json", scope: "project", origin: ".mcp.json" },
      { file: path.join(projectDir, ".codex", "config.toml"), format: "toml", scope: "project", origin: ".codex/config.toml" },
      { file: path.join(projectDir, ".gemini", "settings.json"), format: "json", scope: "project", origin: ".gemini/settings.json" },
    );
  }
  if (kilnHome) {
    sources.push({
      file: path.join(kilnHome, "config", "mcp.yaml"),
      format: "yaml",
      scope: "kiln",
      origin: "kiln",
    });
  }

  const addCodex = () => {
    sources.push({ file: path.join(homeDir, ".codex", "config.toml"), format: "toml", scope: "agent", origin: "codex" });
  };
  const addAntigravity = () => {
    sources.push(
      { file: path.join(homeDir, ".gemini", "antigravity-cli", "mcp_config.json"), format: "json", scope: "agent", origin: "antigravity" },
      { file: path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"), format: "json", scope: "agent", origin: "antigravity" },
      { file: path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"), format: "json", scope: "agent", origin: "antigravity" },
      { file: path.join(homeDir, ".gemini", "settings.json"), format: "json", scope: "agent", origin: "antigravity" },
    );
  };
  const addPi = () => {
    sources.push(
      { file: path.join(homeDir, ".pi", "agent", "mcp.json"), format: "json", scope: "agent", origin: "pi" },
      { file: path.join(homeDir, ".pi", "agent", "settings.json"), format: "json", scope: "agent", origin: "pi" },
    );
  };
  const addClaude = () => {
    sources.push(
      { file: path.join(homeDir, ".claude.json"), format: "json", scope: "agent", origin: "claude" },
      { file: path.join(homeDir, ".claude", "settings.json"), format: "json", scope: "agent", origin: "claude" },
    );
  };

  if (agentFamily === "codex") addCodex();
  else if (agentFamily === "antigravity") addAntigravity();
  else if (agentFamily === "pi") addPi();
  else if (agentFamily === "claude") addClaude();
  else {
    addCodex();
    addAntigravity();
    addPi();
    addClaude();
  }

  const seen = new Set<string>();
  const collected: ChatMcpServerItem[] = [];

  for (const src of sources) {
    const raw = readTextCapped(src.file, MAX_CONFIG_BYTES);
    if (raw === null) continue;
    const names =
      src.format === "json"
        ? extractMcpNamesFromJson(raw)
        : src.format === "toml"
          ? extractMcpNamesFromToml(raw)
          : extractMcpNamesFromYaml(raw);
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({
        name,
        scope: src.scope,
        origin: src.origin,
      });
    }
  }

  const scopeOrder: Record<ChatMcpServerItem["scope"], number> = {
    project: 0,
    kiln: 1,
    agent: 2,
  };
  collected.sort((a, b) => {
    const diff = scopeOrder[a.scope] - scopeOrder[b.scope];
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });

  setBoundedCache(mcpCache, cacheKey, collected);
  return collected.map((item) => ({ ...item }));
}
