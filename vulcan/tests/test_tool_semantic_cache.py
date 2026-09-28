import asyncio
import hashlib
import unittest
from unittest.mock import patch
import json

import numpy as np

from vulcan import agent_runtime, ws_general, recall


class ToolSemanticIndexTests(unittest.TestCase):
    def test_tool_semantic_scores_uses_client_vectors_and_embeds_only_query(self):
        docs = ["browser start browser automation", "send notification ntfy"]
        vectors = {
            hashlib.sha256(docs[0].encode()).hexdigest(): [1.0, 0.0],
            hashlib.sha256(docs[1].encode()).hexdigest(): [0.0, 1.0],
        }
        index = {"complete": True, "model": "BAAI/bge-small-en-v1.5", "dimensions": 2, "vectors": vectors}
        class FakeEncoder:
            calls = []
            def embed(self, texts):
                self.calls.append(list(texts))
                return iter([[1.0, 0.0]])
        encoder = FakeEncoder()
        with patch("vulcan.recall.embedder", return_value=encoder):
            scores = agent_runtime._tool_semantic_scores("browser", docs, index)
        self.assertEqual(encoder.calls, [["browser"]])
        self.assertGreater(scores[0], scores[1])

    def test_incomplete_client_index_is_rejected_without_corpus_embedding(self):
        doc = "browser start browser automation"
        index = {"complete": True, "model": "BAAI/bge-small-en-v1.5", "dimensions": 2, "vectors": {}}
        with self.assertRaises(ValueError):
            agent_runtime._tool_semantic_scores("browser", [doc], index)

    def test_document_canonicalization_matches_client_fixture(self):
        tool = {
            "name": "browser_start", "description": "Start a visible Browser",
            "parameters": {"properties": {
                "headless_mode": {"type": "boolean", "description": "Run without a visible window"},
                "profile": {"type": "string", "description": "Browser profile name"},
            }},
        }
        document, _ = agent_runtime._tool_search_document("Web_Automation", tool)
        expected = "browser start start a visible browser web automation headless mode profile run without a visible window browser profile name"
        self.assertEqual(document, expected)
        self.assertEqual(hashlib.sha256(document.encode()).hexdigest(), "5ec519d0859931ed7db85991e87fdb5d0264ea0a08fe064cb0d5d1fe1b891598")


class SemanticEmbedEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_semantic_embed_route_returns_normalized_vectors_and_model_info(self):
        class Transport:
            def __init__(self): self.sent = []
            async def send_json(self, message): self.sent.append(json.loads(json.dumps(message)))
        class Encoder:
            def __init__(self): self.calls = []
            def embed(self, texts):
                self.calls.append(list(texts))
                return iter([[3.0, 4.0] for _ in texts])

        transport = Transport()
        session = ws_general.GeneralWSSession(transport)
        encoder = Encoder()
        with patch.object(recall, "embedder", return_value=encoder), \
             patch.object(recall, "semantic_model_info", return_value={"model": recall._MODEL_NAME, "dimensions": 2}):
            await session.handle_message({"id": "embed", "type": "semantic/embed", "payload": {"texts": ["alpha", "beta"]}})
        payload = transport.sent[-1]["payload"]
        self.assertEqual(payload["model"], recall._MODEL_NAME)
        self.assertEqual(payload["dimensions"], 2)
        self.assertEqual(encoder.calls, [["alpha", "beta"]])
        self.assertAlmostEqual(payload["vectors"][0][0], 0.6, places=5)
        self.assertAlmostEqual(payload["vectors"][0][1], 0.8, places=5)

    async def test_semantic_embed_info_does_not_run_document_embedding(self):
        class Transport:
            def __init__(self): self.sent = []
            async def send_json(self, message): self.sent.append(message)
        transport = Transport()
        session = ws_general.GeneralWSSession(transport)
        with patch.object(recall, "semantic_model_info", return_value={"model": recall._MODEL_NAME, "dimensions": 384}) as info, \
             patch.object(recall, "embedder") as embedder:
            await session.handle_message({"id": "info", "type": "semantic/embed", "payload": {"texts": []}})
        info.assert_called_once()
        embedder.assert_not_called()
        self.assertEqual(transport.sent[-1]["payload"]["vectors"], [])


if __name__ == "__main__":
    unittest.main()
