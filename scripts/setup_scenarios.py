#!/usr/bin/env python3
"""
LINE Harness scenario setup for bizsp Kindle funnel.

Creates:
- 2 tags: speech / publishing
- 2 scenarios (friend_add trigger with tag_exists conditional step)
- 2 entry_routes via direct D1 SQL (since no REST API)

Usage:
    python scripts/setup_scenarios.py
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

def _load_dev_vars(path: str) -> dict:
    env = {}
    if not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_DEV_VARS = _load_dev_vars(os.path.join(os.path.dirname(__file__), "..", "apps", "worker", ".dev.vars"))

WORKER_URL = os.environ.get("WORKER_URL", "https://line-harness.mymymymy1.workers.dev")
API_KEY = os.environ.get("LH_API_KEY") or _DEV_VARS.get("API_KEY", "")
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")

if not API_KEY:
    sys.exit("ERROR: LH_API_KEY env var or apps/worker/.dev.vars must define API_KEY")
if not CF_TOKEN:
    sys.exit("ERROR: CLOUDFLARE_API_TOKEN env var required")


def api(method, path, body=None):
    url = WORKER_URL + path
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {API_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        print(f"[HTTP {e.code}] {method} {path}: {body_text}", file=sys.stderr)
        raise


def d1_exec(sql):
    """Run a single SQL statement on remote D1 via wrangler."""
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = CF_TOKEN
    cmd = [
        "cmd.exe", "/c",
        f"cd /d C:\\dev\\line-harness\\apps\\worker && "
        f"npx wrangler d1 execute line-harness --remote --command \"{sql}\""
    ]
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        print(f"[D1 ERROR] {result.stderr}", file=sys.stderr)
        raise RuntimeError("D1 execution failed")
    return result.stdout


SPEECH_MSG = """三橋泰介です。ご登録ありがとうございます！

お約束していた「話し方の全技術」完全保存版（全11本・150分超）の動画プレイリストをお送りします。

👉 https://www.youtube.com/playlist?list=PLtkepN9l8KSmV7AFkswIwRJ14ZOSD6mxU

元TBCアナウンサーとして11年以上、現場で磨き続けた技術を凝縮した内容です。通勤中・寝る前など、お好きなタイミングでぜひご視聴ください。

ご感想やご質問があれば、このLINEにそのままメッセージください。必ず目を通します。"""

PUBLISHING_MSG = """三橋泰介です。ご登録ありがとうございます！

お約束していた「出版でビジネスが変わった実例集30選」PDFをお送りします。

👉 PDFダウンロード
https://drive.google.com/file/d/1E7EB9liJvNyRthyCjoNwOySMwI4p7hXJ/view?usp=drive_link

中小企業の社長が1冊の本で売上・採用・ブランドを劇的に変えた実録を30事例掲載しています。

さらに【特別特典】として、本来3万円の個別出版面談（60分・Zoom）を毎月先着5名様限定で無料ご提供中です。

ご興味ある方は、このLINEに「面談希望」とメッセージください。担当より折り返しご案内いたします。"""


def main():
    print("=" * 60)
    print(" LINE Harness Scenario Setup")
    print("=" * 60)

    # 1. Create tags
    print("\n[1/5] Creating tags...")
    tag_speech = api("POST", "/api/tags", {"name": "話し方特典", "color": "#0a1e3f"})
    tag_speech_id = tag_speech["data"]["id"]
    print(f"  [OK] tag '話し方特典' id={tag_speech_id}")

    tag_publishing = api("POST", "/api/tags", {"name": "出版特典", "color": "#5a1e2a"})
    tag_publishing_id = tag_publishing["data"]["id"]
    print(f"  [OK] tag '出版特典' id={tag_publishing_id}")

    # 2. Create scenarios
    print("\n[2/5] Creating scenarios...")
    sc_speech = api("POST", "/api/scenarios", {
        "name": "話し方特典配信",
        "description": "ref=speech 経由の登録者に150分動画プレイリストURLを即時配信",
        "triggerType": "friend_add",
        "isActive": True,
    })
    sc_speech_id = sc_speech["data"]["id"]
    print(f"  [OK] scenario '話し方特典配信' id={sc_speech_id}")

    sc_publishing = api("POST", "/api/scenarios", {
        "name": "出版特典配信",
        "description": "ref=publishing 経由の登録者に30選PDF + 5名無料面談案内を即時配信",
        "triggerType": "friend_add",
        "isActive": True,
    })
    sc_publishing_id = sc_publishing["data"]["id"]
    print(f"  [OK] scenario '出版特典配信' id={sc_publishing_id}")

    # 3. Create scenario steps with tag_exists condition
    print("\n[3/5] Creating scenario steps...")
    step_speech = api("POST", f"/api/scenarios/{sc_speech_id}/steps", {
        "stepOrder": 1,
        "delayMinutes": 0,
        "messageType": "text",
        "messageContent": SPEECH_MSG,
        "conditionType": "tag_exists",
        "conditionValue": tag_speech_id,
    })
    print(f"  [OK] speech step_id={step_speech['data']['id']}")

    step_publishing = api("POST", f"/api/scenarios/{sc_publishing_id}/steps", {
        "stepOrder": 1,
        "delayMinutes": 0,
        "messageType": "text",
        "messageContent": PUBLISHING_MSG,
        "conditionType": "tag_exists",
        "conditionValue": tag_publishing_id,
    })
    print(f"  [OK] publishing step_id={step_publishing['data']['id']}")

    # 4. Create entry_routes via direct SQL
    print("\n[4/5] Creating entry_routes (direct D1 SQL)...")
    import uuid
    er_speech_id = str(uuid.uuid4())
    er_publishing_id = str(uuid.uuid4())

    sql_speech = (
        f"INSERT INTO entry_routes (id, ref_code, name, tag_id, scenario_id, is_active) "
        f"VALUES ('{er_speech_id}', 'speech', '話し方LP経由', '{tag_speech_id}', '{sc_speech_id}', 1)"
    )
    sql_publishing = (
        f"INSERT INTO entry_routes (id, ref_code, name, tag_id, scenario_id, is_active) "
        f"VALUES ('{er_publishing_id}', 'publishing', '出版LP経由', '{tag_publishing_id}', '{sc_publishing_id}', 1)"
    )

    d1_exec(sql_speech)
    print(f"  [OK] entry_route ref_code=speech id={er_speech_id}")
    d1_exec(sql_publishing)
    print(f"  [OK] entry_route ref_code=publishing id={er_publishing_id}")

    # 5. Summary
    print("\n[5/5] Summary:")
    print("=" * 60)
    print(f"  Tag speech:         {tag_speech_id}")
    print(f"  Tag publishing:     {tag_publishing_id}")
    print(f"  Scenario speech:    {sc_speech_id}")
    print(f"  Scenario publishing:{sc_publishing_id}")
    print(f"  Entry route speech:    ref=speech -> tag + scenario")
    print(f"  Entry route publishing:ref=publishing -> tag + scenario")
    print("=" * 60)
    print("\n[DONE] Setup complete. New friends registered via")
    print("       /auth/line?ref=speech or ?ref=publishing will automatically")
    print("       receive their respective welcome message immediately.")


if __name__ == "__main__":
    main()
