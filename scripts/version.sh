#!/usr/bin/env bash
# 版本与回退：给每一轮改动留下可回退的点。
#
#   ./scripts/version.sh show              看当前版本、最近快照、如何回退
#   ./scripts/version.sh save <说明>       存一个代码快照(git archive)，并打 git tag
#   ./scripts/version.sh list              列出所有快照
#   ./scripts/version.sh restore <快照名>  把某个快照的代码恢复到工作区(不碰数据)
#
# 为什么两套并存：
#   - git tag 是「逻辑」回退点，前提是仓库干净；本仓库工作区常有其他会话的未提交改动，
#     单靠 checkout 容易连带丢掉别人的进行中工作。
#   - key-backups/snapshots/*.tar.gz 是「物理」快照，用 git archive 只存 HEAD 跟踪的文件，
#     不含 node_modules / dist / target，也不含 server/data(那是要保的数据另算)。
#     恢复时解到独立目录再对比拷贝，绝不做整目录覆盖式删除。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP_DIR="$ROOT/key-backups/snapshots"
mkdir -p "$SNAP_DIR"

current_version() {
  # 版本号 = 构建序号 + git 短哈希，和 UI 上的构建戳同源可读
  local sha; sha="$(git -C "$ROOT" rev-parse --short HEAD)"
  local n; n="$(git -C "$ROOT" rev-list --count HEAD)"
  echo "build-$n-$sha"
}

# 快照名里的版本号是裸的「序号-哈希」(UI 上显示的就是这一串)，不带 build- 前缀。
bare_version() { current_version | sed 's/^build-//'; }

case "${1:-show}" in
  show)
    echo "当前版本：$(current_version)"
    echo "HEAD：$(git -C "$ROOT" log --oneline -1)"
    echo "快照目录：$SNAP_DIR"
    echo "已有快照："
    if compgen -G "$SNAP_DIR/*.tar.gz" > /dev/null; then
      ls -1t "$SNAP_DIR"/*.tar.gz | sed "s|$SNAP_DIR/||" | sed 's/^/  /'
    else
      echo "  (无)"
    fi
    echo
    echo "回退：./scripts/version.sh restore <上面任一文件名>"
    ;;

  list) ls -1t "$SNAP_DIR"/*.tar.gz 2>/dev/null | sed "s|$SNAP_DIR/||" || echo "(无)" ;;

  save)
    note="${2:?用法: version.sh save <说明>}"
    stamp="$(date +%Y%m%d-%H%M)"
    ver="$(bare_version)"
    safe_note="$(echo "$note" | tr ' /' '--')"
    file="$SNAP_DIR/$stamp-$ver-$safe_note.tar.gz"
    git -C "$ROOT" archive --format=tar HEAD | gzip > "$file"
    count="$(tar tzf "$file" | wc -l | tr -d ' ')"
    git -C "$ROOT" tag -a "snap-$stamp-$safe_note" -m "$note" 2>/dev/null || true
    echo "已存快照：$(basename "$file")（$count 个文件，HEAD=$ver）"
    echo "对应 tag：snap-$stamp-$safe_note"
    ;;

  restore)
    name="${2:?用法: version.sh restore <快照名>}"
    src="$SNAP_DIR/$name"
    [ -f "$src" ] || { echo "找不到快照：$name"; exit 1; }
    work="$(mktemp -d)"
    tar xzf "$src" -C "$work"
    echo "快照已解到临时目录：$work"
    echo
    echo "为安全起见本脚本不做覆盖式还原。请自行核对后拷贝，例如："
    echo "  diff -rq '$work/server' '$ROOT/server' | head -40"
    echo "  cp -r '$work/client/src/'* '$ROOT/client/src/'"
    echo
    echo "或整体回到该 tag（会丢弃未提交改动，先跑 version.sh save 留一份）："
    echo "  git -C '$ROOT' stash -u && git -C '$ROOT' checkout '<tag>'"
    ;;

  *) echo "未知子命令：$1（可用 show/save/list/restore）"; exit 1 ;;
esac
