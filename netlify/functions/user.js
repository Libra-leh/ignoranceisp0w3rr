// netlify/functions/user.js
// Handles: register, login, save-books, save-profile, load
// Uses Netlify Blobs as the database (free, included in all Netlify plans)

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, username, pwHash, profile, books } = body;
  if (!username) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username required' }) };

  const store = getStore({ name: 'library-users', consistency: 'strong' });
  const key = `user_${username.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;

  // ── REGISTER ────────────────────────────────────────────────────────────
  if (action === 'register') {
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    if (existing) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Username already taken' }) };

    await store.setJSON(key, {
      username,
      pwHash,
      profile: profile || {},
      books: books || [],
      createdAt: Date.now(),
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── CHECK USERNAME (does it exist?) ─────────────────────────────────────
  if (action === 'check') {
    const data = await store.get(key, { type: 'json' }).catch(() => null);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ exists: !!data, hasPw: !!(data?.pwHash) }),
    };
  }

  // ── LOGIN ────────────────────────────────────────────────────────────────
  if (action === 'login') {
    const data = await store.get(key, { type: 'json' }).catch(() => null);
    if (!data) return { statusCode: 404, headers, body: JSON.stringify({ error: 'User not found' }) };
    if (data.pwHash && data.pwHash !== pwHash)
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Wrong password' }) };
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, profile: data.profile || {}, books: data.books || [] }),
    };
  }

  // ── SAVE BOOKS ───────────────────────────────────────────────────────────
  if (action === 'save-books') {
    const data = await store.get(key, { type: 'json' }).catch(() => null);
    if (!data) return { statusCode: 404, headers, body: JSON.stringify({ error: 'User not found' }) };
    if (data.pwHash && data.pwHash !== pwHash)
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    await store.setJSON(key, { ...data, books, updatedAt: Date.now() });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // ── SAVE PROFILE ─────────────────────────────────────────────────────────
  if (action === 'save-profile') {
    const data = await store.get(key, { type: 'json' }).catch(() => null);
    if (!data) return { statusCode: 404, headers, body: JSON.stringify({ error: 'User not found' }) };
    if (data.pwHash && data.pwHash !== pwHash)
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    await store.setJSON(key, { ...data, profile, updatedAt: Date.now() });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
