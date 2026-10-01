"""Render an API-format workflow with {{param}} placeholders and POST it to ComfyUI.

usage:
  python comfy_client.py render <workflow.json> key=value ...
  python comfy_client.py run <workflow.json> key=value ...
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")
DEFAULT_SERVER = "http://127.0.0.1:8188"


def coerce(raw: str):
    lowered = raw.strip().lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def render(template: dict, params: dict) -> dict:
    def walk(node):
        if isinstance(node, dict):
            return {key: walk(value) for key, value in node.items()}
        if isinstance(node, list):
            return [walk(item) for item in node]
        if isinstance(node, str):
            match = PLACEHOLDER.fullmatch(node)
            if match:
                key = match.group(1)
                if key not in params:
                    raise KeyError(f"missing parameter {key!r}")
                return params[key]
            return node
        return node

    return walk(template)


def request(url: str, payload=None, timeout: int = 30):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read()
    return json.loads(body) if body else None


def main(argv: list[str]) -> int:
    mode, workflow, rest = argv[1], argv[2], argv[3:]
    server = DEFAULT_SERVER
    timeout = 1800
    params: dict = {}
    positional = []
    index = 0
    while index < len(rest):
        item = rest[index]
        if item == "--server":
            server = rest[index + 1]
            index += 2
        elif item == "--timeout":
            timeout = int(rest[index + 1])
            index += 2
        else:
            positional.append(item)
            index += 1
    for item in positional:
        if "=" not in item:
            raise SystemExit(f"expected key=value, got {item!r}")
        key, value = item.split("=", 1)
        params[key] = coerce(value)

    with open(workflow, encoding="utf-8") as handle:
        template = json.load(handle)
    graph = render(template, params)

    if mode == "render":
        print(json.dumps(graph, indent=2, ensure_ascii=False))
        return 0

    print(f"queueing {workflow} on {server} ...", flush=True)
    queued = request(f"{server}/prompt", {"prompt": graph})
    print("queued:", json.dumps(queued, ensure_ascii=False), flush=True)
    prompt_id = queued["prompt_id"]

    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.0)
        try:
            history = request(f"{server}/history/{prompt_id}", timeout=15)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            continue
        if history and prompt_id in history:
            entry = history[prompt_id]
            print("status:", json.dumps(entry.get("status", {}), ensure_ascii=False)[:400], flush=True)
            images = []
            for node_output in (entry.get("outputs") or {}).values():
                images.extend(node_output.get("images") or [])
            print("images:", json.dumps(images, ensure_ascii=False), flush=True)
            return 0 if images else 1
    print("timeout waiting for history", flush=True)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))