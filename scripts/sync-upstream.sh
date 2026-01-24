#!/bin/bash
#
# sync-upstream.sh - Safely sync fork with upstream preserving 1-1 commit history
#
# Usage:
#   ./scripts/sync-upstream.sh [OPTIONS] [N]
#
# Arguments:
#   N                 Number of commits to sync (default: all pending commits)
#
# Options:
#   -h, --help        Show this help message
#   -c, --check       Scan for dangerous commits only (no merge)
#   -l, --list        List pending commits only
#
# Examples:
#   ./scripts/sync-upstream.sh           # Sync all pending commits
#   ./scripts/sync-upstream.sh 10        # Sync first 10 commits
#   ./scripts/sync-upstream.sh -c        # Scan for dangerous commits
#   ./scripts/sync-upstream.sh -l        # List all pending commits
#
# The script will auto-merge commits one by one and STOP when:
#   1. A commit would DELETE/RENAME files we modified (stops BEFORE that commit)
#   2. A merge conflict occurs (stops for manual resolution)
#   3. All commits merged successfully (done!)
#
# After resolving, run again to continue from where it stopped.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
CHECK_ONLY=false
LIST_ONLY=false
NUM_COMMITS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            head -30 "$0" | tail -28
            exit 0
            ;;
        -c|--check)
            CHECK_ONLY=true
            shift
            ;;
        -l|--list)
            LIST_ONLY=true
            shift
            ;;
        *)
            if [[ "$1" =~ ^[0-9]+$ ]]; then
                NUM_COMMITS="$1"
            else
                echo -e "${RED}Unknown option: $1${NC}"
                echo "Use --help for usage information"
                exit 1
            fi
            shift
            ;;
    esac
done

# Ensure we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo -e "${RED}ERROR: Not on main branch (currently on: $CURRENT_BRANCH)${NC}"
    echo "Run: git checkout main"
    exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --staged --quiet; then
    echo -e "${RED}ERROR: Working directory has uncommitted changes${NC}"
    echo "Commit or stash changes first"
    exit 1
fi

# Fetch upstream
echo -e "${BLUE}Fetching upstream...${NC}"
git fetch upstream

# Get list of pending commits (chronological order - oldest first)
if [[ -n "$NUM_COMMITS" ]]; then
    COMMITS=$(git log --reverse --format=%H upstream/main ^main | head -n "$NUM_COMMITS")
    COMMIT_COUNT=$(echo "$COMMITS" | grep -c . || echo 0)
    echo -e "${BLUE}Found $COMMIT_COUNT commits to process (limited to $NUM_COMMITS)${NC}"
else
    COMMITS=$(git log --reverse --format=%H upstream/main ^main)
    COMMIT_COUNT=$(echo "$COMMITS" | grep -c . || echo 0)
    echo -e "${BLUE}Found $COMMIT_COUNT pending commits${NC}"
fi

if [[ "$COMMIT_COUNT" -eq 0 ]]; then
    echo -e "${GREEN}Already up to date with upstream!${NC}"
    exit 0
fi

# List only mode
if [[ "$LIST_ONLY" == true ]]; then
    echo -e "${BLUE}Pending commits (chronological order):${NC}"
    if [[ -n "$NUM_COMMITS" ]]; then
        git log --reverse --oneline upstream/main ^main | head -n "$NUM_COMMITS"
    else
        git log --reverse --oneline upstream/main ^main
    fi
    exit 0
fi

# Get files we modified (for danger detection)
BASE=$(git merge-base HEAD upstream/main) || { echo -e "${RED}ERROR: merge-base failed${NC}"; exit 1; }
OUR_FILES=$(git diff "$BASE"..HEAD --name-only | sort)

# Check only mode - scan all commits for dangerous ones
if [[ "$CHECK_ONLY" == true ]]; then
    echo -e "${BLUE}Scanning commits for dangerous deletions/renames...${NC}"
    FOUND_DANGEROUS=false

    for COMMIT in $COMMITS; do
        SHORT_HASH=$(git rev-parse --short "$COMMIT")
        TITLE=$(git log -1 --format=%s "$COMMIT")

        # Get files this commit deletes/renames
        COMMIT_DANGEROUS=$(git diff --diff-filter=DR --name-only "${COMMIT}^".."${COMMIT}" 2>/dev/null | sort)

        # Find intersection with our files
        AFFECTED=$(comm -12 <(echo "$OUR_FILES") <(echo "$COMMIT_DANGEROUS") | grep -v '^$' || true)

        if [[ -n "$AFFECTED" ]]; then
            FOUND_DANGEROUS=true
            echo -e "${RED}DANGEROUS: $SHORT_HASH - $TITLE${NC}"
            echo "  Deletes/renames files we modified:"
            echo "$AFFECTED" | sed 's/^/    /'
            echo ""
        fi
    done

    if [[ "$FOUND_DANGEROUS" == true ]]; then
        echo -e "${YELLOW}Found dangerous commits - review before syncing${NC}"
        exit 1
    else
        echo -e "${GREEN}No dangerous commits found - safe to sync all${NC}"
        exit 0
    fi
fi

# Auto-merge commits one by one
echo -e "${BLUE}Starting auto-merge...${NC}"
MERGED=0

for COMMIT in $COMMITS; do
    SHORT_HASH=$(git rev-parse --short "$COMMIT")
    TITLE=$(git log -1 --format=%s "$COMMIT")

    # Check if this commit is dangerous BEFORE merging
    COMMIT_DANGEROUS=$(git diff --diff-filter=DR --name-only "${COMMIT}^".."${COMMIT}" 2>/dev/null | sort)
    AFFECTED=$(comm -12 <(echo "$OUR_FILES") <(echo "$COMMIT_DANGEROUS") | grep -v '^$' || true)

    if [[ -n "$AFFECTED" ]]; then
        echo ""
        echo -e "${RED}══════════════════════════════════════════════════════════${NC}"
        echo -e "${RED}STOPPING: Next commit deletes/renames files we modified${NC}"
        echo -e "${RED}══════════════════════════════════════════════════════════${NC}"
        echo ""
        echo "Commit: $SHORT_HASH - $TITLE"
        echo ""
        echo "Files affected:"
        echo "$AFFECTED" | sed 's/^/  /'
        echo ""
        echo "To examine the commit:"
        echo "  git show $COMMIT"
        echo ""
        echo "To proceed manually:"
        echo "  git merge $COMMIT"
        echo "  # Resolve carefully, preserving our features"
        echo "  git add . && git commit"
        echo "  # Then run this script again to continue"
        echo ""
        if [[ "$MERGED" -gt 0 ]]; then
            echo -e "${GREEN}Successfully merged $MERGED commits before stopping${NC}"
        fi
        exit 1
    fi

    echo -e "${BLUE}[$((MERGED + 1))/$COMMIT_COUNT] Merging $SHORT_HASH: $TITLE${NC}"

    if git merge "$COMMIT" -m "Merge(Auto) Commit '$SHORT_HASH': $TITLE"; then
        MERGED=$((MERGED + 1))
        echo -e "${GREEN}✓ Merged successfully${NC}"
    else
        echo ""
        echo -e "${YELLOW}══════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}CONFLICT at commit $SHORT_HASH${NC}"
        echo -e "${YELLOW}══════════════════════════════════════════════════════════${NC}"
        echo ""
        echo "Commit: $TITLE"
        echo ""
        echo "To resolve:"
        echo "  1. Fix conflicts in the listed files"
        echo "  2. git add ."
        echo "  3. git commit"
        echo "  4. Run this script again to continue"
        echo ""
        echo "To examine the commit:"
        echo "  git show $COMMIT"
        echo ""
        echo "To abort the merge:"
        echo "  git merge --abort"
        echo ""
        echo -e "${GREEN}Successfully merged $MERGED commits before conflict${NC}"
        exit 1
    fi
done

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Successfully merged all $MERGED commits!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Verify build: npm install && npm run build"
echo "  2. Test critical features"
echo "  3. Push: git push"
