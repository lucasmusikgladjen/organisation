const express = require('express');
const path = require('path');

// Load .env file if present (simple implementation, no dotenv dependency)
const fs = require('fs');
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex !== -1) {
          const key = trimmed.slice(0, eqIndex).trim();
          const val = trimmed.slice(eqIndex + 1).trim();
          if (!process.env[key]) process.env[key] = val;
        }
      }
    }
  }
} catch (_) { /* ignore */ }

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const NOTE_PASSWORD = process.env.NOTE_PASSWORD;
const BASE_ID = 'appTiSaQRF1ePoADL';
const TABLE_ID = 'tblBrPSBgquHNh3hD';
const AIRTABLE_URL = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: make Airtable request using native https
function airtableRequest(method, urlPath, body) {
  const https = require('https');
  const url = urlPath ? `${AIRTABLE_URL}/${urlPath}` : AIRTABLE_URL;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// GET /api/notes - Fetch all records (handles pagination)
app.get('/api/notes', async (req, res) => {
  try {
    let allRecords = [];
    let offset = null;

    do {
      const https = require('https');
      const params = new URLSearchParams();
      if (offset) params.set('offset', offset);

      const url = `${AIRTABLE_URL}?${params.toString()}`;
      const parsed = new URL(url);

      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          },
        };

        const r = https.request(options, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve(JSON.parse(body));
            } else {
              reject({ status: response.statusCode, body });
            }
          });
        });
        r.on('error', reject);
        r.end();
      });

      allRecords = allRecords.concat(data.records);
      offset = data.offset || null;
    } while (offset);

    // Strip password-protected note content server-side
    const sanitized = allRecords.map((r) => ({
      id: r.id,
      fields: {
        'Område': r.fields['Område'] || '',
        'Anteckningar': r.fields['Lösenord'] ? '' : (r.fields['Anteckningar'] || ''),
        'Position X': r.fields['Position X'] || '',
        'Position Y': r.fields['Position Y'] || '',
        'Lösenord': !!r.fields['Lösenord'],
      },
    }));

    res.json({ records: sanitized });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// POST /api/notes - Create a new note
app.post('/api/notes', async (req, res) => {
  try {
    const { fields } = req.body;
    const data = await airtableRequest('POST', '', {
      records: [{ fields }],
    });
    res.json(data.records[0]);
  } catch (err) {
    console.error('Create error:', err);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// PATCH /api/notes/batch - Batch update positions (up to 10 records per Airtable limit)
app.patch('/api/notes/batch', async (req, res) => {
  try {
    const { records } = req.body;
    // Airtable allows max 10 records per batch update
    const results = [];
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10);
      const data = await airtableRequest('PATCH', '', { records: batch });
      results.push(...data.records);
    }
    res.json({ records: results });
  } catch (err) {
    console.error('Batch update error:', err);
    res.status(500).json({ error: 'Failed to batch update notes' });
  }
});

// PATCH /api/notes/:id - Update a single note
app.patch('/api/notes/:id', async (req, res) => {
  try {
    const { fields } = req.body;
    const data = await airtableRequest('PATCH', '', {
      records: [{ id: req.params.id, fields }],
    });
    res.json(data.records[0]);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// POST /api/notes/:id/unlock - Verify password and return note content
app.post('/api/notes/:id/unlock', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== NOTE_PASSWORD) {
      return res.status(403).json({ error: 'Incorrect password' });
    }

    // Fetch the specific record to get the real content
    const https = require('https');
    const url = `${AIRTABLE_URL}/${req.params.id}`;
    const parsed = new URL(url);

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` },
      };
      const r = https.request(options, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject({ status: response.statusCode, body });
          }
        });
      });
      r.on('error', reject);
      r.end();
    });

    res.json({ content: data.fields['Anteckningar'] || '' });
  } catch (err) {
    console.error('Unlock error:', err);
    res.status(500).json({ error: 'Failed to unlock note' });
  }
});

// DELETE /api/notes/:id - Delete a note (requires password)
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== NOTE_PASSWORD) {
      return res.status(403).json({ error: 'Incorrect password' });
    }

    const https = require('https');
    const url = `${AIRTABLE_URL}/${req.params.id}`;
    const parsed = new URL(url);

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` },
      };
      const r = https.request(options, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            reject({ status: response.statusCode, body });
          }
        });
      });
      r.on('error', reject);
      r.end();
    });

    res.json({ deleted: true, id: data.id });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// POST /api/verify-password - Verify password (for delete confirmation)
app.post('/api/verify-password', (req, res) => {
  const { password } = req.body;
  if (password === NOTE_PASSWORD) {
    res.json({ valid: true });
  } else {
    res.status(403).json({ valid: false, error: 'Incorrect password' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`note-canvas running on http://localhost:${PORT}`);
});
