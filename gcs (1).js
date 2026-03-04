// netlify/functions/gcs.js
// Proxies Google Custom Search image requests — API key stays server-side.
// Set env vars in Netlify: GCS_KEY and GCS_CX

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const GCS_KEY = process.env.GCS_KEY;
  const GCS_CX  = process.env.GCS_CX;

  if (!GCS_KEY || !GCS_CX) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GCS_KEY or GCS_CX not set' }) };
  }

  // Build params manually — avoids Node 16 URLSearchParams(object) issues
  const qs = event.queryStringParameters || {};
  const parts = [];
  for (const [k, v] of Object.entries(qs)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  parts.push(`key=${encodeURIComponent(GCS_KEY)}`);
  parts.push(`cx=${encodeURIComponent(GCS_CX)}`);

  const url = `https://www.googleapis.com/customsearch/v1?${parts.join('&')}`;

  try {
    const res  = await fetch(url);
    const body = await res.text();
    return { statusCode: res.status, headers, body };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
