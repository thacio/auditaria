#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('commit', {
      alias: 'c',
      description: 'The commit SHA to cherry-pick for the patch.',
      type: 'string',
      demandOption: true,
    })
    .option('channel', {
      alias: 'ch',
      description: 'The release channel to patch.',
      choices: ['stable', 'preview'],
      demandOption: true,
    })
    .option('dry-run', {
      description: 'Whether to run in dry-run mode.',
      type: 'boolean',
      default: false,
    })
    .option('skip-pr-creation', {
      description: 'Only create branches, skip PR creation.',
      type: 'boolean',
      default: false,
    })
    .option('pr-only', {
      description: 'Only create PR, skip branch creation.',
      type: 'boolean',
      default: false,
    })
    .help()
    .alias('help', 'h').argv;

  const { commit, channel, dryRun, skipPrCreation, prOnly } = argv;

  // Validate mutually exclusive flags
  if (skipPrCreation && prOnly) {
    console.error(
      'Error: --skip-pr-creation and --pr-only are mutually exclusive.',
    );
    process.exit(1);
  }

  console.log(`Starting patch process for commit: ${commit}`);
  console.log(`Targeting channel: ${channel}`);
  if (dryRun) {
    console.log('Running in dry-run mode.');
  }
  if (skipPrCreation) {
    console.log('Mode: Branch creation only (skipping PR creation)');
  }
  if (prOnly) {
    console.log('Mode: PR creation only (skipping branch creation)');
  }

  if (!prOnly) {
    run('git fetch --all --tags --prune', dryRun);
  }

  const latestTag = getLatestTag(channel);
  console.log(`Found latest tag for ${channel}: ${latestTag}`);

  const releaseBranch = `release/${latestTag}`;
  const hotfixBranch = `hotfix/${latestTag}/${channel}/cherry-pick-${commit.substring(0, 7)}`;

  // If PR-only mode, skip all branch creation logic
  if (prOnly) {
    console.log(
      'PR-only mode: Skipping branch creation, proceeding to PR creation...',
    );
    // Jump to PR creation section
    return await createPullRequest(
      hotfixBranch,
      releaseBranch,
      commit,
      channel,
      dryRun,
      false,
    );
  }

  // Create the release branch from the tag if it doesn't exist.
  if (!branchExists(releaseBranch)) {
    console.log(
      `Release branch ${releaseBranch} does not exist. Creating it from tag ${latestTag}...`,
    );
    // Workaround for workflow permission issues: create branch from HEAD then reset to tag
    run(`git checkout -b ${releaseBranch}`, dryRun);
    run(`git reset --hard ${latestTag}`, dryRun);
    run(`git push origin ${releaseBranch}`, dryRun);
  } else {
    console.log(`Release branch ${releaseBranch} already exists.`);
  }

  // Check if hotfix branch already exists
  if (branchExists(hotfixBranch)) {
    console.log(`Hotfix branch ${hotfixBranch} already exists.`);

    // Check if there's already a PR for this branch
    try {
      const prInfo = execSync(
        `gh pr list --head ${hotfixBranch} --json number,url --jq '.[0] // empty'`,
      )
        .toString()
        .trim();
      if (prInfo && prInfo !== 'null' && prInfo !== '') {
        const pr = JSON.parse(prInfo);
        console.log(`Found existing PR #${pr.number}: ${pr.url}`);
        console.log(`Hotfix branch ${hotfixBranch} already has an open PR.`);
        return { existingBranch: hotfixBranch, existingPR: pr };
      } else {
        console.log(`Hotfix branch ${hotfixBranch} exists but has no open PR.`);
        console.log(
          `You may need to delete the branch and run this command again.`,
        );
        return { existingBranch: hotfixBranch };
      }
    } catch (err) {
      console.error(`Error checking for existing PR: ${err.message}`);
      console.log(`Hotfix branch ${hotfixBranch} already exists.`);
      return { existingBranch: hotfixBranch };
    }
  }

  // Create the hotfix branch from the release branch.
  console.log(
    `Creating hotfix branch ${hotfixBranch} from ${releaseBranch}...`,
  );
  run(`git checkout -b ${hotfixBranch} origin/${releaseBranch}`, dryRun);

  // Ensure git user is configured properly for commits
  console.log('Configuring git user for cherry-pick commits...');
  run('git config user.name "gemini-cli-robot"', dryRun);
  run('git config user.email "gemini-cli-robot@google.com"', dryRun);

  // Cherry-pick the commit.
  console.log(`Cherry-picking commit ${commit} into ${hotfixBranch}...`);
  let hasConflicts = false;
  if (!dryRun) {
    try {
      execSync(`git cherry-pick ${commit}`, { stdio: 'pipe' });
      console.log(`✅ Cherry-pick successful - no conflicts detected`);
    } catch (error) {
      // Check if this is a cherry-pick conflict
      try {
        const status = execSync('git status --porcelain', { encoding: 'utf8' });
        const conflictFiles = status
          .split('\n')
          .filter(
            (line) =>
              line.startsWith('UU ') ||
              line.startsWith('AA ') ||
              line.startsWith('DU ') ||
              line.startsWith('UD '),
          );

        if (conflictFiles.length > 0) {
          hasConflicts = true;
          console.log(
            `⚠️  Cherry-pick has conflicts in ${conflictFiles.length} file(s):`,
          );
          conflictFiles.forEach((file) =>
            console.log(`   - ${file.substring(3)}`),
          );

          // Add all files (including conflict markers) and commit
          console.log(
            `📝 Creating commit with conflict markers for manual resolution...`,
          );
          execSync('git add .');
          execSync(`git commit --no-edit`);
          console.log(`✅ Committed cherry-pick with conflict markers`);
        } else {
          // Re-throw if it's not a conflict error
          throw error;
        }
      } catch (_statusError) {
        // Re-throw original error if we can't determine the status
        throw error;
      }
    }
  } else {
    console.log(`[DRY RUN] Would cherry-pick ${commit}`);
  }

  // Push the hotfix branch.
  console.log(`Pushing hotfix branch ${hotfixBranch} to origin...`);
  run(`git push --set-upstream origin ${hotfixBranch}`, dryRun);

  // If skip-pr-creation mode, stop here
  if (skipPrCreation) {
    console.log(
      '✅ Branch creation completed! Skipping PR creation as requested.',
    );
    if (hasConflicts) {
      console.log(
        '⚠️  Note: Conflicts were detected during cherry-pick - manual resolution required before PR creation!',
      );
    }
    return {
      newBranch: hotfixBranch,
      created: true,
      hasConflicts,
      skippedPR: true,
    };
  }

  // Create the pull request
  return await createPullRequest(
    hotfixBranch,
    releaseBranch,
    commit,
    channel,
    dryRun,
    hasConflicts,
  );
}

async function createPullRequest(
  hotfixBranch,
  releaseBranch,
  commit,
  channel,
  dryRun,
  hasConflicts,
) {
  console.log(
    `Creating pull request from ${hotfixBranch} to ${releaseBranch}...`,
  );
  let prTitle = `fix(patch): cherry-pick ${commit.substring(0, 7)} to ${releaseBranch}`;
  let prBody = `This PR automatically cherry-picks commit ${commit} to patch the ${channel} release.`;

  if (hasConflicts) {
    prTitle = `fix(patch): cherry-pick ${commit.substring(0, 7)} to ${releaseBranch} [CONFLICTS]`;
    prBody += `

## ⚠️ Merge Conflicts Detected

This cherry-pick resulted in merge conflicts that need manual resolution.

### 🔧 Next Steps:
1. **Review the conflicts**: Check out this branch and review the conflict markers
2. **Resolve conflicts**: Edit the affected files to resolve the conflicts
3. **Test the changes**: Ensure the patch works correctly after resolution
4. **Update this PR**: Push your conflict resolution

### 📋 Files with conflicts:
The commit has been created with conflict markers for easier manual resolution.

### 🚨 Important:
- Do not merge this PR until conflicts are resolved
- The automated patch release will trigger once this PR is merged`;
  }

  if (dryRun) {
    prBody += '\n\n**[DRY RUN]**';
  }

  const prCommand = `gh pr create --base ${releaseBranch} --head ${hotfixBranch} --title "${prTitle}" --body "${prBody}"`;
  run(prCommand, dryRun);

  if (hasConflicts) {
    console.log(
      '⚠️  Patch process completed with conflicts - manual resolution required!',
    );
  } else {
    console.log('✅ Patch process completed successfully!');
  }

  if (dryRun) {
    console.log('\n--- Dry Run Summary ---');
    console.log(`Release Branch: ${releaseBranch}`);
    console.log(`Hotfix Branch: ${hotfixBranch}`);
    console.log(`Pull Request Command: ${prCommand}`);
    console.log('---------------------');
  }

  return { newBranch: hotfixBranch, created: true, hasConflicts };
}

function run(command, dryRun = false, throwOnError = true) {
  console.log(`> ${command}`);
  if (dryRun) {
    return;
  }
  try {
    return execSync(command).toString().trim();
  } catch (err) {
    console.error(`Command failed: ${command}`);
    if (throwOnError) {
      throw err;
    }
    return null;
  }
}

function branchExists(branchName) {
  try {
    execSync(`git ls-remote --exit-code --heads origin ${branchName}`);
    return true;
  } catch (_e) {
    return false;
  }
}

function getLatestTag(channel) {
  console.log(`Fetching latest tag for channel: ${channel}...`);
  const pattern =
    channel === 'stable'
      ? '(contains("nightly") or contains("preview")) | not'
      : '(contains("preview"))';
  const command = `gh release list --limit 30 --json tagName | jq -r '[.[] | select(.tagName | ${pattern})] | .[0].tagName'`;
  try {
    return execSync(command).toString().trim();
  } catch (err) {
    console.error(`Failed to get latest tag for channel: ${channel}`);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
