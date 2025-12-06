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

/**
 * Skill Definition Interface
 */
interface SkillDefinition {
  name: string;
  description: string;
  platforms: {
    windows: {
      url: string;
      zipName: string;
    };
    linux: {
      url: string;
      zipName: string;
    };
    macos: {
      url: string;
      zipName: string;
    };
  };
}

/**
 * Available Skills Registry
 *
 * This is the centralized list of all available skills.
 * To add a new skill, simply add it to this object.
 */
const AVAILABLE_SKILLS: Record<string, SkillDefinition> = {
  'docx-writing-skill': {
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
  // Future skills can be added here
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
 * Execute skill setup action - shared by both direct action and subcommand actions
 */
async function executeSkillSetup(
  context: CommandContext,
  skillId: string,
  skill: SkillDefinition,
): Promise<ReturnType<NonNullable<SlashCommand['action']>>> {
  // Detect platform and get appropriate download config
  const platform = detectPlatform();
  const platformConfig = skill.platforms[platform];

  if (!platformConfig) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Skill ${skillId} is not available for platform: ${platform}`,
    };
  }

  // Initialize generic skill setup service
  const workingDir = context.services.config?.getWorkingDir() || process.cwd();
  const skillService = new SkillSetupService(workingDir);

  // Show progress message
  context.ui.addItem(
    {
      type: 'info',
      text: `Installing skill: ${skill.name}...`,
    },
    Date.now(),
  );

  try {
    // Execute generic setup
    const result = await skillService.setupSkill({
      skillName: skillId,
      downloadUrl: platformConfig.url,
      zipFileName: platformConfig.zipName,
    });

    // If setup was successful and it's docx-writing-skill, refresh parser status
    if (result.success && skillId === 'docx-writing-skill' && context.web) {
      // Notify web interface to refresh parser detection
      // The web interface will handle this through WebInterfaceService.refreshParserStatus()
      setTimeout(() => {
        // This will be called via WebInterfaceService after command completes
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
      ? {
          type: 'message',
          messageType: 'info',
          content: `✓ ${result.message}`,
        }
      : {
          type: 'message',
          messageType: 'error',
          content: `✗ ${result.message}`,
        };
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
 * Generate subCommands from AVAILABLE_SKILLS registry
 * This enables autocomplete in both CLI and web interface
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
 * The skill setup is generic - specific skill functionality is handled
 * by dedicated services (e.g., DocxParserService for docx-writing-skill).
 */
export const setupSkillCommand: SlashCommand = {
  name: 'setup-skill',
  description: 'download and setup a skill',
  kind: CommandKind.BUILT_IN,
  // SubCommands enable autocomplete in web interface (which can't use completion functions)
  subCommands: generateSkillSubCommands(),
  // completion is kept for CLI compatibility (fuzzy search, filtering)
  completion: async (_context: CommandContext, _partialArg: string) =>
    Object.keys(AVAILABLE_SKILLS),
  action: async (context: CommandContext, args: string) => {
    const skillId = args.trim();

    // Validate skill name provided
    if (!skillId) {
      const availableSkills = Object.keys(AVAILABLE_SKILLS).join(', ');
      return {
        type: 'message',
        messageType: 'error',
        content: `Please specify a skill name. Available skills: ${availableSkills}`,
      };
    }

    // Validate skill exists
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
