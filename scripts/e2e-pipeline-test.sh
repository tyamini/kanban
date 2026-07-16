#!/usr/bin/env bash
#
# End-to-end Kanban pipeline test on the hello-kanban board.
#
# Builds a 4-task dependency chain that runs (almost) fully autonomously:
#
#   task-1.txt (auto-commit, empty file)
#     -> color.txt (auto-commit; asks red/blue then WAITS in review for your answer)
#          -> research segment-routing (no auto-review; self-completes via the
#             kanban-task-done skill)
#               -> something.txt (auto-commit; writes the handed-off
#                  segment-routing summary from the research task)
#
# The ONLY manual step: while `color.txt` sits in review asking "red or blue",
# open that task and answer. Everything else is automatic.
#
# Expected result: three files committed to the base ref ("main"):
#   - task-1.txt   : empty
#   - color.txt    : the color you answered
#   - something.txt : 2-3 lines about segment routing (from the research handoff)
#
# Env overrides:
#   KANBAN_BIN      command to run the CLI (default: node <repo>/dist/cli.js)
#   KANBAN_PROJECT  path to the board repo   (default: ~/hello-kanban)
#   BASE_REF        base branch for the tasks (default: kanbanTestBranch1)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KANBAN_BIN=${KANBAN_BIN:-"node $REPO_ROOT/dist/cli.js"}
PROJECT=${KANBAN_PROJECT:-"$HOME/hello-kanban"}
BASE_REF=${BASE_REF:-kanbanTestBranch1}

kanban() { eval "$KANBAN_BIN $(printf '%q ' "$@")"; }
task_id() { python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])"; }

echo "== 1. Reset test files on $BASE_REF in $PROJECT =="
git -C "$PROJECT" checkout -q "$BASE_REF"
changed=0
for f in task-1.txt color.txt something.txt; do
	if git -C "$PROJECT" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
		git -C "$PROJECT" rm -q "$f"
		changed=1
	elif [ -e "$PROJECT/$f" ]; then
		rm -f "$PROJECT/$f"
	fi
done
if [ "$changed" = 1 ]; then
	git -C "$PROJECT" commit -q -m "test: reset pipeline files"
	echo "   removed task-1.txt / color.txt / something.txt and committed"
else
	echo "   nothing to remove (already clean)"
fi

echo "== 2. Create 4 backlog tasks =="
T1=$(kanban task create --project-path "$PROJECT" --base-ref "$BASE_REF" \
	--title "task-1.txt" \
	--prompt "Create an empty file named task-1.txt in the repository root. Do not add any content to it." \
	--auto-review-enabled true --auto-review-mode commit --agent-id claude | task_id)

COLOR=$(kanban task create --project-path "$PROJECT" --base-ref "$BASE_REF" \
	--title "color.txt" \
	--prompt "First ask me whether color.txt should contain 'red' or 'blue', then STOP and wait for my answer - do NOT create the file yet. After I reply, create a file named color.txt in the repository root whose only content is the exact color I chose." \
	--auto-review-enabled true --auto-review-mode commit --agent-id claude | task_id)

RESEARCH=$(kanban task create --project-path "$PROJECT" --base-ref "$BASE_REF" \
	--title "research segment-routing" \
	--prompt "Search the web about segment routing. This task changes no files, so you MUST finish it yourself with the kanban-task-done skill: ACTUALLY RUN its 'kanban task done' shell command (do not merely say you will). IMPORTANT: the very last thing you write BEFORE running that command must be your complete 2-line summary of what segment routing is. Do NOT write any narration such as 'now I'll run the command' between that summary and the command - the summary must be your final words, then run the command immediately." \
	--auto-review-enabled false --agent-id claude | task_id)

SOMETHING=$(kanban task create --project-path "$PROJECT" --base-ref "$BASE_REF" \
	--title "something.txt" \
	--prompt "Create a file named something.txt in the repository root. Write into it the 2-3 line segment-routing summary provided in the upstream context above. If no upstream context is present, write a 2-3 line summary of what segment routing is." \
	--auto-review-enabled true --auto-review-mode commit --agent-id claude | task_id)

echo "   task-1=$T1  color=$COLOR  research=$RESEARCH  something=$SOMETHING"

echo "== 3. Link the chain (prerequisite -> waiter) =="
kanban task link --project-path "$PROJECT" --task-id "$COLOR" --linked-task-id "$T1" >/dev/null
kanban task link --project-path "$PROJECT" --task-id "$RESEARCH" --linked-task-id "$COLOR" >/dev/null
# research -> something carries the research summary into something's prompt:
kanban task link --project-path "$PROJECT" --task-id "$SOMETHING" --linked-task-id "$RESEARCH" --handoff summary >/dev/null
echo "   task-1 -> color -> research -> something (summary handoff on the last edge)"

echo "== 4. Start the pipeline =="
kanban task start --project-path "$PROJECT" --task-id "$T1" >/dev/null

cat <<EOF

Pipeline started. It now runs on its own with ONE manual step:
  -> When 'color.txt' is in Review asking red or blue, open it and answer.

Then expect these committed to $BASE_REF:
  task-1.txt (empty), color.txt (your answer), something.txt (segment-routing summary).
EOF
