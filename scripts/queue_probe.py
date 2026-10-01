"""POST a rendered workflow to ComfyUI and print the raw error body on rejection."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, r"E:\agent project\dsh-comfyui-image\scripts")
from comfy_client import render  # noqa: E402


def main(argv: list[str]) -> int:
    workflow, params_json, server = argv[1], argv[2], argv[3] if len(argv) > 3 else "http://127.0.0.1:8188"
    with open(workflow, encoding="utf-8") as handle:
        template = json.load(handle)
    graph = render(template, json.loads(params_json))
    data = json.dumps({"prompt": graph}).encode("utf-8")
    req = urllib.request.Request(
        f"{server}/prompt", data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            print("OK", response.read().decode("utf-8"))
            return 0
    except urllib.error.HTTPError as exc:
        print("HTTP", exc.code)
        print(exc.read().decode("utf-8", errors="replace")[:4000])
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))