import asyncio
import time
import unittest
from unittest import mock

from vulcan import auth, ws_general


class _Transport:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


class ConnectionRecoveryTests(unittest.TestCase):
    def tearDown(self):
        auth._sessions.clear()

    def test_proof_of_life_reissues_expired_subordinate_capability(self):
        async def scenario():
            transport = _Transport()
            session = ws_general.GeneralWSSession(transport)
            session.authenticated = True

            with mock.patch.object(ws_general.auth, 'server_requires_auth', return_value=True):
                old_token = auth.create_session('ws-general:test')
                session.session_token = old_token
                auth._sessions[old_token].last_seen = time.time() - auth.SESSION_TTL - 1

                await session._client_proof_of_life('proof-1', {})

                self.assertNotEqual(session.session_token, old_token)
                self.assertNotIn(old_token, auth._sessions)
                self.assertIn(session.session_token, auth._sessions)
                self.assertEqual(transport.sent[-1]['type'], 'client/proof-of-life/response')
                self.assertEqual(
                    transport.sent[-1]['payload']['session_token'],
                    session.session_token,
                )

        asyncio.run(scenario())

    def test_proof_of_life_keeps_current_capability_when_still_valid(self):
        async def scenario():
            transport = _Transport()
            session = ws_general.GeneralWSSession(transport)
            session.authenticated = True

            with mock.patch.object(ws_general.auth, 'server_requires_auth', return_value=True):
                token = auth.create_session('ws-general:test')
                session.session_token = token
                before = auth._sessions[token].last_seen
                await asyncio.sleep(0)
                await session._client_proof_of_life('proof-2', {})
                self.assertEqual(session.session_token, token)
                self.assertGreaterEqual(auth._sessions[token].last_seen, before)

        asyncio.run(scenario())


if __name__ == '__main__':
    unittest.main()
