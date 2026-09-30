"""Tiny Home Assistant WebSocket client for scripted checks.

    .venv/bin/python scripts/ha_ws.py '{"type": "get_config"}' ['{...}' ...]

Reads url + token from the JSON file named by $HA_KEY_FILE: {"url": "http://host:8123", "token": "…"}.
Prints each result as JSON.
"""

import asyncio
import json
import os
import sys

import aiohttp

KEY_FILE = os.environ.get("HA_KEY_FILE") or sys.exit("set HA_KEY_FILE to a JSON file with url and token")


async def main(commands):
    key = json.load(open(KEY_FILE))
    url = key["url"].rstrip("/").replace("http", "ws", 1) + "/api/websocket"
    async with aiohttp.ClientSession() as session, session.ws_connect(url, timeout=aiohttp.ClientWSTimeout(ws_close=30)) as ws:
        await ws.receive_json()  # auth_required
        await ws.send_json({"type": "auth", "access_token": key["token"]})
        auth = await ws.receive_json()
        if auth["type"] != "auth_ok":
            sys.exit(f"auth failed: {auth}")
        for i, cmd in enumerate(commands, start=1):
            await ws.send_json({"id": i, **cmd})
            while True:
                msg = await ws.receive_json(timeout=120)
                if msg.get("id") == i and msg["type"] == "result":
                    print(json.dumps(msg.get("result") if msg["success"] else {"error": msg["error"]}, ensure_ascii=False))
                    break


asyncio.run(main([json.loads(a) for a in sys.argv[1:]]))
