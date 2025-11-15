/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AUDITARIA_SKILLS - Agent Skills Implementation
 *
 * This file implements support for Anthropic's Agent Skills system in Auditaria.
 * It is completely self-contained to avoid circular dependencies.
 *
 * Skills are modular capabilities stored as SKILL.md files with YAML frontmatter.
 * They enable Auditaria to access specialized domain knowledge and workflows.
 *
 * Architecture:
 * - Skills stored in: .auditaria/skills/{skill-name}/SKILL.md
 * - Discovery: Scans filesystem for SKILL.md files
 * - Metadata injection: Adds skill descriptions to system prompt
 * - Progressive loading: Auditaria reads SKILL.md and related files via Read/Bash tools
 *
 * @see https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { GEMINI_DIR } from '../utils/paths.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Skill metadata extracted from YAML frontmatter
 */
interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  skillDir: string;
}

/**
 * Main entry point: Loads skills and returns formatted prompt section
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Formatted markdown section to inject into system prompt, or empty string if no skills
 */
export async function loadSkillsPromptSection(
  projectRoot: string,
): Promise<string> {
  try {
    const skills = await discoverSkills(projectRoot);

    if (skills.length === 0) {
      return '';
    }

    // Log summary of loaded skills
    const skillNames = skills.map(s => s.name).join(', ');
    console.log(`✓ Loaded ${skills.length} skill(s): ${skillNames}`);

    return formatSkillsSection(skills, projectRoot);
  } catch (error) {
    console.error('✗ Failed to load skills:', error);
    debugLogger.warn('Failed to load skills:', error);
    return '';
  }
}

/**
 * Discovers all valid skills in the project's .auditaria/skills directory
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Array of skill metadata for all discovered valid skills
 */
async function discoverSkills(
  projectRoot: string,
): Promise<SkillMetadata[]> {
  const skillsDir = path.join(projectRoot, GEMINI_DIR, 'skills');

  // Check if skills directory exists
  try {
    await fs.access(skillsDir);
  } catch {
    // Skills directory doesn't exist - this is fine, just no skills available
    debugLogger.debug(`Skills directory not found: ${skillsDir}`);
    return [];
  }

  // Read all entries in skills directory
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    console.error('✗ Failed to read skills directory:', error);
    debugLogger.warn(`Failed to read skills directory: ${skillsDir}`, error);
    return [];
  }

  // Process each potential skill directory
  const skills: SkillMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue; // Skip files in skills root
    }

    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    try {
      const metadata = await parseSkillMetadata(skillMdPath, skillDir);
      if (metadata && validateSkillMetadata(metadata)) {
        skills.push(metadata);
      }
    } catch (error) {
      console.error(
        `✗ Failed to load skill "${entry.name}":`,
        error instanceof Error ? error.message : error,
      );
      debugLogger.debug(
        `Skipping invalid skill at ${skillDir}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  debugLogger.debug(`Discovered ${skills.length} valid skill(s)`);
  return skills;
}

/**
 * Parses SKILL.md file and extracts metadata from YAML frontmatter
 *
 * @param skillMdPath - Absolute path to SKILL.md file
 * @param skillDir - Absolute path to skill directory
 * @returns Skill metadata if parsing succeeds, null otherwise
 */
async function parseSkillMetadata(
  skillMdPath: string,
  skillDir: string,
): Promise<SkillMetadata | null> {
  let content: string;

  try {
    content = await fs.readFile(skillMdPath, 'utf-8');
  } catch {
    return null; // SKILL.md doesn't exist
  }

  // Parse YAML frontmatter
  // Expected format:
  // ---
  // name: skill-name
  // description: What this skill does
  // ---
  const frontmatterMatch = content.match(
    /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
  );

  if (!frontmatterMatch) {
    throw new Error('Invalid SKILL.md format: missing YAML frontmatter');
  }

  const yamlContent = frontmatterMatch[1];

  // Parse YAML using js-yaml
  let parsedYaml: any;
  try {
    parsedYaml = yaml.load(yamlContent);
  } catch (error) {
    throw new Error(
      `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Extract required fields
  if (!parsedYaml || typeof parsedYaml !== 'object') {
    throw new Error('YAML frontmatter must be an object');
  }

  const name = parsedYaml.name;
  const description = parsedYaml.description;

  if (!name || typeof name !== 'string') {
    throw new Error('Missing or invalid required field: name (must be a string)');
  }

  if (!description || typeof description !== 'string') {
    throw new Error(
      'Missing or invalid required field: description (must be a string)',
    );
  }

  const metadata: SkillMetadata = {
    name: name.trim(),
    description: description.trim(),
    path: skillMdPath,
    skillDir,
  };

  return metadata;
}

/**
 * Validates skill metadata according to Anthropic's Agent Skills specification
 *
 * @param metadata - Skill metadata to validate
 * @returns true if valid, false otherwise (logs warnings for invalid skills)
 */
function validateSkillMetadata(metadata: SkillMetadata): boolean {
  const errors: string[] = [];

  // Validate name
  if (metadata.name.length === 0) {
    errors.push('name cannot be empty');
  } else if (metadata.name.length > 64) {
    errors.push('name exceeds 64 characters');
  } else if (!/^[a-z0-9-]+$/.test(metadata.name)) {
    errors.push(
      'name must contain only lowercase letters, numbers, and hyphens',
    );
  } else if (/anthropic|claude/i.test(metadata.name)) {
    errors.push('name cannot contain reserved words: anthropic, claude');
  } else if (/<[^>]+>/.test(metadata.name)) {
    errors.push('name cannot contain XML tags');
  }

  // Validate description
  if (metadata.description.length === 0) {
    errors.push('description cannot be empty');
  } else if (metadata.description.length > 1024) {
    errors.push('description exceeds 1024 characters');
  } else if (/<[^>]+>/.test(metadata.description)) {
    errors.push('description cannot contain XML tags');
  }

  if (errors.length > 0) {
    debugLogger.warn(
      `Invalid skill "${metadata.name}" at ${metadata.skillDir}:`,
      errors.join(', '),
    );
    return false;
  }

  return true;
}

/**
 * Formats discovered skills into a markdown section for the system prompt
 *
 * @param skills - Array of skill metadata
 * @param projectRoot - Absolute path to the project root
 * @returns Formatted markdown section describing available skills
 */
function formatSkillsSection(
  skills: SkillMetadata[],
  projectRoot: string,
): string {
  const relativeSkillsDir = path.join(GEMINI_DIR, 'skills');

  const skillsList = skills
    .map((skill) => {
      const skillPath = path.join(relativeSkillsDir, skill.name, 'SKILL.md');
      return `  - **${skill.name}**: ${skill.description}`;
    })
    .join('\n');

  return `
## Available Skills

The skills below contain domain expertise and workflows for particular tasks

${skillsList}

**How to use skills:**
1. Access skill documentation by reading: \`${relativeSkillsDir}/{skill-name}/SKILL.md\`
2. Follow the guidelines and procedures outlined in each skill
3. Skills may include reading additional files (such as reference.md, examples.md) - read them when needed for additional context

Skills àre loaded incrementally when required - only access a skill when it's directly relevant to completing the task.
`;
}
