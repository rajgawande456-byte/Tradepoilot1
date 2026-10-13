import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createUser,
  authenticateUser,
  createSession,
  getSession,
  revokeSession
} from './service.mjs';

import {
  query,
  closeDatabase
} from '../db/client.mjs';

test(
  'authentication and session integration',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const email =
      `tradepilot-test-${crypto.randomUUID()}@example.com`;

    const password = 'TestPassword123!';
    let userId;

    try {
      const user = await createUser({
        email: ` ${email.toUpperCase()} `,
        password
      });

      userId = user.id;

      assert.equal(user.email, email);

      const authenticated = await authenticateUser({
        email,
        password
      });

      assert.equal(authenticated.id, userId);

      await assert.rejects(
        authenticateUser({
          email,
          password: 'WrongPassword123!'
        }),
        { code: 'INVALID_CREDENTIALS' }
      );

      const session = await createSession(userId);

      assert.ok(session.token);

      const activeSession = await getSession(
        session.token
      );

      assert.equal(activeSession.user_id, userId);

      await revokeSession(session.token);

      assert.equal(
        await getSession(session.token),
        null
      );
    } finally {
      try {
        if (userId) {
          await query(
            'DELETE FROM sessions WHERE user_id = $1',
            [userId]
          );

          await query(
            'DELETE FROM users WHERE id = $1',
            [userId]
          );
        }
      } finally {
        await closeDatabase();
      }
    }
  }
);
