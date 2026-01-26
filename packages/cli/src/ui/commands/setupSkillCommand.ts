/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type SlashCommand,
  CommandKind,
  type CommandContext,
} from './types.js';
import { SkillSetupService } from '../../services/SkillSetupService.js';

// AUDITARIA_FEATURE_START: Skill definition as discriminated union
/**
 * Skill Definition - Discriminated Union
 *
 * Use `type` field to distinguish between skill installation methods:
 * - 'platform-zip': Platform-specific ZIP downloads (binaries, assets)
 * - 'skill-md': Simple SKILL.md file download (instructions only)
 *
 * To add a new installation method, add a new union member.
 */
type SkillDefinition =
  | {
      type: 'platform-zip';
      name: string;
      description: string;
      platforms: {
        windows: { url: string; zipName: string };
        linux: { url: string; zipName: string };
        macos: { url: string; zipName: string };
      };
    }
  | {
      type: 'skill-md';
      name: string;
      description: string;
      skillMdUrl: string;
    };
// AUDITARIA_FEATURE_END

/**
 * Available Skills Registry
 *
 * Centralized list of all available skills.
 * To add a new skill, add an entry with the appropriate `type`.
 */
const AVAILABLE_SKILLS: Record<string, SkillDefinition> = {
  'docx-writing-skill': {
    type: 'platform-zip',
    name: 'DOCX Writing Skill',
    description: 'Parse markdown to DOCX format',
    platforms: {
      windows: {
        url: 'https://github.com/thacio/markup_to_docx_parser_releases/releases/download/latest/parser-windows.zip',
        zipName: 'parser-windows.zip',
      },
      linux: {
        url: 'https://github.com/thacio/markup_to_docx_parser_releases/releases/download/latest/parser-linux.zip',
        zipName: 'parser-linux.zip',
      },
      macos: {
        url: 'https://github.com/thacio/markup_to_docx_parser_releases/releases/download/latest/parser-macos.zip',
        zipName: 'parser-macos.zip',
      },
    },
  },
  'deep-research-knowledge-base': {
    type: 'skill-md',
    name: 'Deep Research Knowledge Base',
    description:
      'Iterative research on knowledge base with evidence-based reports',
    skillMdUrl:
      'https://github.com/thacio/auditaria/raw/refs/heads/main/.auditaria/skills/deep-research-knowledge-base/SKILL.md',
  },
};

/**
 * Detect platform helper
 */
function detectPlatform(): 'windows' | 'linux' | 'macos' {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/**
 * Execute skill setup - handles all skill types via discriminated union
 */
async function executeSkillSetup(
  context: CommandContext,
  skillId: string,
  skill: SkillDefinition,
): Promise<ReturnType<NonNullable<SlashCommand['action']>>> {
  // Show progress message
  context.ui.addItem(
    { type: 'info', text: `Installing skill: ${skill.name}...` },
    Date.now(),
  );

  const workingDir = context.services.config?.getWorkingDir() || process.cwd();

  try {
    // AUDITARIA_FEATURE_START: Handle skill types via discriminated union
    if (skill.type === 'platform-zip') {
      return await setupPlatformZipSkill(context, skillId, skill, workingDir);
    } else if (skill.type === 'skill-md') {
      return await setupSkillMdSkill(skillId, skill, workingDir);
    }
    // TypeScript will error if we miss a case (exhaustiveness check)
    const _exhaustive: never = skill;
    return _exhaustive;
    // AUDITARIA_FEATURE_END
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      type: 'message',
      messageType: 'error',
      content: `Error setting up skill: ${errorMsg}`,
    };
  }
}

/**
 * Setup platform-specific ZIP skill
 */
async function setupPlatformZipSkill(
  context: CommandContext,
  skillId: string,
  skill: Extract<SkillDefinition, { type: 'platform-zip' }>,
  workingDir: string,
): Promise<ReturnType<NonNullable<SlashCommand['action']>>> {
  const platform = detectPlatform();
  const platformConfig = skill.platforms[platform];

  if (!platformConfig) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Skill ${skillId} is not available for platform: ${platform}`,
    };
  }

  const skillService = new SkillSetupService(workingDir);
  const result = await skillService.setupSkill({
    skillName: skillId,
    downloadUrl: platformConfig.url,
    zipFileName: platformConfig.zipName,
  });

  // Special handling for docx-writing-skill
  if (result.success && skillId === 'docx-writing-skill' && context.web) {
    setTimeout(() => {
      context.ui.addItem(
        {
          type: 'info',
          text: 'DOCX parser is now available in the web interface.',
        },
        Date.now(),
      );
    }, 500);
  }

  return result.success
    ? { type: 'message', messageType: 'info', content: `✓ ${result.message}` }
    : { type: 'message', messageType: 'error', content: `✗ ${result.message}` };
}

/**
 * Setup simple SKILL.md skill
 */
async function setupSkillMdSkill(
  skillId: string,
  skill: Extract<SkillDefinition, { type: 'skill-md' }>,
  workingDir: string,
): Promise<ReturnType<NonNullable<SlashCommand['action']>>> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const skillDir = path.join(workingDir, '.auditaria', 'skills', skillId);
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  // Create skill directory
  await fs.mkdir(skillDir, { recursive: true });

  // Download SKILL.md
  const response = await fetch(skill.skillMdUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download SKILL.md: ${response.status} ${response.statusText}`,
    );
  }
  const content = await response.text();

  // Save SKILL.md
  await fs.writeFile(skillMdPath, content, 'utf-8');

  return {
    type: 'message',
    messageType: 'info',
    content: `✓ Skill "${skill.name}" installed successfully at ${skillDir}`,
  };
}

/**
 * Generate subCommands from AVAILABLE_SKILLS registry
 */
function generateSkillSubCommands(): SlashCommand[] {
  return Object.entries(AVAILABLE_SKILLS).map(([skillId, skill]) => ({
    name: skillId,
    description: skill.description,
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: async (context: CommandContext) =>
      executeSkillSetup(context, skillId, skill),
  }));
}

/**
 * Setup Skill Slash Command
 *
 * Usage: /setup-skill <skill-name>
 * Example: /setup-skill docx-writing-skill
 *
 * This command downloads and installs skills from predefined sources.
 */
export const setupSkillCommand: SlashCommand = {
  name: 'setup-skill',
  description: 'download and setup a skill',
  kind: CommandKind.BUILT_IN,
  subCommands: generateSkillSubCommands(),
  completion: async (_context: CommandContext, _partialArg: string) =>
    Object.keys(AVAILABLE_SKILLS),
  action: async (context: CommandContext, args: string) => {
    const skillId = args.trim();

    if (!skillId) {
      const availableSkills = Object.keys(AVAILABLE_SKILLS).join(', ');
      return {
        type: 'message',
        messageType: 'error',
        content: `Please specify a skill name. Available skills: ${availableSkills}`,
      };
    }

    const skill = AVAILABLE_SKILLS[skillId];
    if (!skill) {
      const availableSkills = Object.keys(AVAILABLE_SKILLS).join(', ');
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown skill: ${skillId}. Available skills: ${availableSkills}`,
      };
    }

    return executeSkillSetup(context, skillId, skill);
  },
};

// Export for use by other services if needed
export { AVAILABLE_SKILLS };
