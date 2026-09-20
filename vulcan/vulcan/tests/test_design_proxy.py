import asyncio
import types
from unittest import mock

from vulcan import server


def test_design_target_preserves_registered_base_and_query():
    design = {"url": "http://127.0.0.1:5173/app?theme=dark"}
    assert server._design_target(design) == "http://127.0.0.1:5173/app?theme=dark"
    assert server._design_target(design, "assets/app.js") == "http://127.0.0.1:5173/app/assets/app.js"
    assert server._design_target(design, "assets/app.js", query_items=[("v", "2"), ("vulcan_session", "secret")]) == \
        "http://127.0.0.1:5173/app/assets/app.js?v=2"
    assert server._design_target(design, "@vite/client", root_absolute=True, query_items=[("vulcan_design_root", "1")]) == \
        "http://127.0.0.1:5173/@vite/client"


def test_design_lookup_and_legacy_cookie_cleanup():
    chat = {"id": "chat-1", "designs": [{"id": "design-1", "name": "App", "url": "http://localhost:5173"}]}
    with mock.patch.object(server.chats, "load_chat_metadata", return_value=chat):
        assert server._design_by_id("chat-1", "design-1")["name"] == "App"
    cleaned = server._strip_legacy_design_cookie("theme=dark; vulcan_design_route=opaque; app=1")
    assert cleaned == "theme=dark; app=1"


async def _exercise_http_proxy():
    captured = {}

    class Upstream:
        status_code = 200
        headers = types.SimpleNamespace(
            items=lambda: [("content-type", "text/javascript")],
            get=lambda key, default=None: default,
            get_list=lambda key: [],
        )
        async def aiter_raw(self):
            yield b"ok"
        async def aclose(self):
            captured["closed"] = True

    class Client:
        def __init__(self, **kwargs):
            captured["client"] = kwargs
        def build_request(self, **kwargs):
            captured["request"] = kwargs
            return object()
        async def send(self, request, stream=False):
            captured["stream"] = stream
            return Upstream()
        async def aclose(self):
            captured["client_closed"] = True

    class Query:
        def multi_items(self):
            return [("v", "2"), ("vulcan_session", "DO_NOT_FORWARD")]

    class Request:
        method = "GET"
        query_params = Query()
        headers = {
            "host": "vulcan.example",
            "authorization": "Bearer SECRET",
            "cookie": "vulcan_design_route=opaque; app_session=keep",
            "origin": "https://vulcan.example",
        }
        async def body(self):
            return b""

    design = {"url": "http://127.0.0.1:5173/"}
    client = Client()
    with mock.patch.object(server.network, "client", new=mock.AsyncMock(return_value=client)):
        response = await server._proxy_design_http(Request(), design, "@vite/client", root_absolute=True)
        chunks = [chunk async for chunk in response.body_iterator]
    assert chunks == [b"ok"]
    request = captured["request"]
    assert request["url"] == "http://127.0.0.1:5173/@vite/client?v=2"
    assert "authorization" not in request["headers"]
    assert request["headers"]["cookie"] == "app_session=keep"
    assert request["headers"]["origin"] == "http://127.0.0.1:5173"
    assert captured["stream"] is True


def test_design_http_proxy_strips_vulcan_credentials_and_routes_root_assets():
    asyncio.run(_exercise_http_proxy())


def test_private_origin_uses_explicit_design_route_without_global_cookie_router():
    # Private-origin transport rewrites every request into /design/<chat>/<design>/...;
    # there must be no global HTTP middleware or routing-cookie state left behind.
    source = __import__("inspect").getsource(server)
    assert "_design_root_proxy" not in source
    assert "_design_tickets" not in source
    assert "_issue_design_ticket" not in source


def test_vulcan_general_websocket_survives_design_middleware():
    """Design routing must never break Vulcan's own control WebSocket."""
    import base64
    import json
    import os
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import x25519
    from fastapi.testclient import TestClient

    client = TestClient(server.app)
    with client.websocket_connect("/ws/general") as websocket:
        hello = json.loads(websocket.receive_text())
        assert hello["type"] == "handshake/server"
        assert hello["version"] == 1

        ephemeral = x25519.X25519PrivateKey.generate().public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        websocket.send_text(json.dumps({
            "type": "handshake/client",
            "version": 1,
            "ephemeral": base64.b64encode(ephemeral).decode("ascii"),
            "send_prefix": base64.b64encode(os.urandom(4)).decode("ascii"),
        }))
        ready = json.loads(websocket.receive_text())
        assert ready == {"type": "handshake/ready", "version": 1}



def test_design_screenshot_workspace_path_is_safe():
    assert server._design_screenshot_workspace_path("screenshots/design-app.png") == "screenshots/design-app.png"
    assert server._design_screenshot_workspace_path("/workspace/screenshots/design-app.png") == "screenshots/design-app.png"
    for invalid in ("../escape.png", "/tmp/escape.png", "screenshots/not-png.jpg", "screenshots/../escape.png"):
        try:
            server._design_screenshot_workspace_path(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsafe screenshot path accepted: {invalid}")


def test_design_screenshot_upload_writes_png_directly_to_workspace():
    png = b"\x89PNG\r\n\x1a\n" + b"fake-png-payload"

    class Query:
        def get(self, key, default=None):
            return "screenshots/design-app.png" if key == "path" else default

    class Request:
        query_params = Query()
        headers = {"content-length": str(len(png))}
        async def body(self):
            return png

    design = {"id": "design-1", "name": "App", "url": "http://localhost:5173"}
    with mock.patch.object(server, "_design_by_id", return_value=design), \
         mock.patch.object(server.workspace, "write_file_bytes") as write:
        result = asyncio.run(server.design_screenshot_upload(Request(), "chat-1", "design-1"))
    assert result["ok"] is True
    assert result["saved_to"] == "/workspace/screenshots/design-app.png"
    assert result["workspace_path"] == "screenshots/design-app.png"
    assert result["bytes"] == len(png)
    write.assert_called_once_with("chat-1", "screenshots/design-app.png", png)
