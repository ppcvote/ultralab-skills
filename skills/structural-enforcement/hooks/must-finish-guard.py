#!/usr/bin/env python3
"""
must-finish-guard.py — Claude Code Stop hook: the four safety valves without a backend.

情境：你不維護自己的模型呼叫迴圈，只用 Claude Code。但「一定要做完某事」的
需求一樣存在：改完程式一定要跑測試、說做完之前一定要有部署動作、回覆前一定要
先寫檔。提示層擋不住它中途收工，這支 hook 用結構擋。

原理（全部只用有文件保證的原語）：
  - Stop hook 以 exit code 2 擋下收工，stderr 的文字會餵回給模型當回饋
  - 判斷「該做的做了沒」讀 transcript_path 裡真實的 tool_use 紀錄，
    不讀模型在文字裡的自述（它宣稱做完卻沒呼叫工具，正是要擋的 bug 本身）
  - 防迴圈第一道用文件保證的 stop_hook_active 欄位（為 true 代表這次收工
    已經是 stop hook 擋過之後的接續，一律放行）；第二道自己用
    session_id + prompt_id 記 marker（prompt_id 若拿不到會退化成
    「同一個 session 只擋一次」，只會多放行、不會多擋）

四道閥在這支檔案裡的位置，用註解標出。

安裝：
  1. 放到 <專案>/.claude/hooks/must-finish-guard.py
  2. settings.json 的 hooks.Stop 加上執行指令
  3. 改下面的 REQUIRED 清單成你的需求
  4. 陽性對照（檔案末尾有步驟）跑過才算裝好

設計原則：不確定時一律放行（exit 0）。一個誤擋的 hook 會把使用者困在
對話裡，比漏擋貴得多。這支寧可漏擋。
"""
import json
import os
import re
import sys
import tempfile

# ── 你的「一定要做完」清單 ──────────────────────────────────────────
# 每一條：當這一輪出現過 trigger 類的工具呼叫，就必須也出現 required 類的。
# name 只用於訊息。pattern 比對的是 transcript 裡 tool_use 的工具名稱。
REQUIRED = [
    {
        "name": "改了程式要跑過測試",
        "trigger": r"^(Edit|Write|NotebookEdit)$",
        "trigger_input": r"\.(ts|tsx|js|jsx|py|mjs|cjs)\"",   # 只在改到程式檔時生效
        "required": r"^(Bash)$",
        "required_input": r"(test|vitest|jest|pytest|npm run test|node --test)",
        "ask": "這一輪改了程式檔，但 transcript 裡沒有任何跑測試的紀錄。先跑測試，貼出結果再收工。",
    },
]

STATE_DIR = os.path.join(tempfile.gettempdir(), "must-finish-guard")


def _role(entry):
    """transcript 每行的 role 藏在 message 底下（頂層沒有 role 欄位）。
    兩種形狀都試，讀不到回 None。"""
    msg = entry.get("message")
    if isinstance(msg, dict) and msg.get("role"):
        return msg.get("role")
    return entry.get("role")


def _content(entry):
    msg = entry.get("message")
    if isinstance(msg, dict) and msg.get("content") is not None:
        return msg.get("content")
    return entry.get("content")


def _is_human_turn(entry):
    """真人輸入的那一行。注意：工具結果也是 role=user 的行（content 裡是
    tool_result），錨點若錯抓到它，之後就掃不到任何 tool_use，hook 永遠不擋。"""
    if _role(entry) != "user":
        return False
    c = _content(entry)
    if isinstance(c, str):
        return True
    if isinstance(c, list):
        return not any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
    return False


def read_tool_uses(transcript_path):
    """從 transcript 抓最後一次真人輸入之後所有真實的 tool_use。
    拿不到就回 None，呼叫端據此放行：不確定時不擋人。"""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        with open(transcript_path, encoding="utf-8") as fh:
            lines = [json.loads(l) for l in fh if l.strip()]
    except (json.JSONDecodeError, OSError):
        return None
    last_user = max((i for i, e in enumerate(lines) if _is_human_turn(e)), default=None)
    if last_user is None:
        return None
    uses = []
    for e in lines[last_user:]:
        content = _content(e)
        if not isinstance(content, list):
            continue
        for c in content:
            if isinstance(c, dict) and c.get("type") == "tool_use":
                uses.append({"name": c.get("name", ""), "input": json.dumps(c.get("input", {}), ensure_ascii=False)})
    return uses


def forced_marker(session_id, prompt_id):
    safe = re.sub(r"[^\w-]", "_", f"{session_id}__{prompt_id}")
    return os.path.join(STATE_DIR, safe)


def main():
    try:
        evt = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0  # 讀不懂輸入就放行，不要把人困住

    # 閥一：只強制一次。第一道用文件保證的欄位：stop_hook_active 為 true
    # 代表這次收工已經是 stop hook 擋過之後的接續，一律放行。
    # 這同時就是閥二：被擋那一輪做完事之後，下一次 Stop 一定過得去，
    # 模型永遠有收尾的機會，不會被困在迴圈裡。
    if evt.get("stop_hook_active"):
        return 0

    session_id = str(evt.get("session_id", ""))
    prompt_id = str(evt.get("prompt_id", ""))

    # 第二道保險：自己記 marker。prompt_id 不是文件保證的欄位，拿不到時
    # 退化成「同一個 session 只擋一次」，只會多放行、不會多擋。
    marker = forced_marker(session_id, prompt_id)
    if os.path.exists(marker):
        return 0

    # 閥三：前提條件用「真實發生過什麼」判斷，讀 transcript 的 tool_use 紀錄。
    # 讀不到 transcript 就放行：沒有證據時不強制，強制會逼出幻覺。
    uses = read_tool_uses(evt.get("transcript_path"))
    if uses is None:
        return 0

    for rule in REQUIRED:
        triggered = any(
            re.search(rule["trigger"], u["name"]) and re.search(rule.get("trigger_input", ""), u["input"])
            for u in uses
        )
        if not triggered:
            continue
        satisfied = any(
            re.search(rule["required"], u["name"]) and re.search(rule.get("required_input", ""), u["input"])
            for u in uses
        )
        if satisfied:
            continue

        # 記下「已強制」再擋。順序不能反：先擋再記的話，記錄那步失敗
        # 會變成無限迴圈（同一種先後順序問題，對照 verification-discipline
        # 的 Rule 3：完成標記的先後順序決定失敗是重試還是永久靜默）。
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(marker, "w") as fh:
            fh.write("1")

        # 閥四：用文件保證的機制（exit 2＋stderr 回饋）回到正常對話迴圈。
        # 接下來那一輪是普通的一輪：權限照問、額度照算，什麼都沒被繞過。
        print(rule["ask"], file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())

# ── 陽性對照（裝完必做，兩個方向都要）────────────────────────────────
# 1. 該擋的有擋：叫 Claude 改一個 .ts 檔然後直接說「好了」不跑測試。
#    它收工時應該被擋下，並看到你設的那句話，然後補跑測試。
# 2. 不會擋兩次：同一輪它補跑了測試（或就是不跑）之後再收工，必須放行。
# 3. 該放的有放：問一個不改程式的問題，收工不應該被擋。
# 三個都過了才算裝好。只做第一個，你裝的可能是一個把人困住的迴圈。
