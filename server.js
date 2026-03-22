const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'sparkcoach.db');

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function initDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS parents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS children (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      pin_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES parents(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id INTEGER NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      summary TEXT,
      FOREIGN KEY (child_id) REFERENCES children(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function requireParent(req, res, next) {
  if (!req.session.parentId) {
    setFlash(req, 'error', 'Please sign in first.');
    res.redirect('/parent/login');
    return;
  }
  next();
}

function requireChild(req, res, next) {
  if (!req.session.childId) {
    setFlash(req, 'error', 'Please enter your PIN first.');
    res.redirect('/child/login');
    return;
  }
  next();
}

function fallbackCoachReply(lastMessage) {
  const prompt = (lastMessage || '').trim();
  if (!prompt) {
    return 'Hi! I am Spark Coach. Want to do one tiny learning step?';
  }

  const shortEcho = prompt.split(/\s+/).slice(0, 6).join(' ');
  const choices = [
    `Awesome effort! You said: "${shortEcho}". Let us do one small step. What is one key word you notice?`,
    'Great try. You are doing well. Can you say that idea in your own words using one short sentence?',
    'Nice work sticking with it. Let us break it into parts. What is the first part you understand?' 
  ];

  const index = prompt.length % choices.length;
  return choices[index];
}

async function generateCoachReply(childName, messages) {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackCoachReply(messages[messages.length - 1]?.content || '');
  }

  try {
    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 140,
      messages: [
        {
          role: 'system',
          content:
            'You are Spark Coach, a warm AI learning coach for kids ages 6-12 with dyslexia and ADHD. Use short, simple sentences and friendly words. Keep replies to 2-4 short lines. Ask one small follow-up question. Avoid complex vocabulary and long blocks of text.'
        },
        ...messages.map((message) => ({
          role: message.sender === 'child' ? 'user' : 'assistant',
          content: message.content
        }))
      ]
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`OpenAI call failed: ${response.status}`);
    }

    const json = await response.json();
    const text = json.choices?.[0]?.message?.content?.trim();
    return text || `Great work, ${childName}! Tell me one part you want to practice next.`;
  } catch (error) {
    return fallbackCoachReply(messages[messages.length - 1]?.content || '');
  }
}

async function generateSessionSummary(childName, sessionMessages) {
  const childMessages = sessionMessages.filter((message) => message.sender === 'child');

  if (process.env.OPENAI_API_KEY && sessionMessages.length > 0) {
    try {
      const payload = {
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 180,
        messages: [
          {
            role: 'system',
            content:
              'Write a session recap for a child age 6-12 with dyslexia/ADHD. Keep language very simple. Return exactly 3 short lines. Line 1: celebration. Line 2: what they practiced. Line 3: one tiny next step.'
          },
          {
            role: 'user',
            content: `Child name: ${childName}. Messages: ${sessionMessages
              .map((message) => `${message.sender}: ${message.content}`)
              .join(' | ')}`
          }
        ]
      };

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`OpenAI summary call failed: ${response.status}`);
      }

      const json = await response.json();
      const summary = json.choices?.[0]?.message?.content?.trim();
      if (summary) {
        return summary;
      }
    } catch (error) {
      // Fall back to a deterministic summary.
    }
  }

  const childTurns = childMessages.length;
  const lastChildMessage = childMessages[childMessages.length - 1]?.content || 'You shared your ideas.';
  const shortLast = lastChildMessage.split(/\s+/).slice(0, 8).join(' ');

  return [
    `Great work today, ${childName}! You showed strong effort.`,
    `You completed ${childTurns} practice turn${childTurns === 1 ? '' : 's'} and shared ideas like: "${shortLast}".`,
    'Tiny next step: read one short sentence and tell Spark Coach one new word.'
  ].join('\n');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
    secret: process.env.SESSION_SECRET || 'spark-coach-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.locals.parentId = req.session.parentId;
  res.locals.childId = req.session.childId;
  res.locals.childName = req.session.childName;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.get('/', (req, res) => {
  res.render('index', { pageTitle: 'Spark Coach' });
});

app.get('/parent/signup', (req, res) => {
  res.render('parent-signup', { pageTitle: 'Parent Sign Up' });
});

app.post('/parent/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || password.length < 8) {
    setFlash(req, 'error', 'Use a valid email and 8+ character password.');
    res.redirect('/parent/signup');
    return;
  }

  const existingParent = await get('SELECT id FROM parents WHERE email = ?', [email]);
  if (existingParent) {
    setFlash(req, 'error', 'That email is already used. Please sign in.');
    res.redirect('/parent/login');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const insertResult = await run('INSERT INTO parents (email, password_hash) VALUES (?, ?)', [
    email,
    passwordHash
  ]);

  req.session.parentId = insertResult.id;
  req.session.childId = null;
  req.session.childName = null;
  req.session.currentSessionId = null;
  setFlash(req, 'success', 'Welcome! Your account is ready.');
  res.redirect('/parent/dashboard');
});

app.get('/parent/login', (req, res) => {
  res.render('parent-login', { pageTitle: 'Parent Sign In' });
});

app.post('/parent/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const parent = await get('SELECT id, password_hash FROM parents WHERE email = ?', [email]);
  if (!parent) {
    setFlash(req, 'error', 'No account found. Try again.');
    res.redirect('/parent/login');
    return;
  }

  const matches = await bcrypt.compare(password, parent.password_hash);
  if (!matches) {
    setFlash(req, 'error', 'Wrong password. Try again.');
    res.redirect('/parent/login');
    return;
  }

  req.session.parentId = parent.id;
  req.session.childId = null;
  req.session.childName = null;
  req.session.currentSessionId = null;
  setFlash(req, 'success', 'Welcome back!');
  res.redirect('/parent/dashboard');
});

app.post('/parent/logout', (req, res) => {
  req.session.parentId = null;
  req.session.currentSessionId = null;
  setFlash(req, 'success', 'You are signed out.');
  res.redirect('/');
});

app.get('/parent/dashboard', requireParent, async (req, res) => {
  const children = await all(
    `
      SELECT
        c.id,
        c.name,
        c.age,
        c.created_at,
        COUNT(s.id) AS total_sessions,
        MAX(s.ended_at) AS last_session
      FROM children c
      LEFT JOIN sessions s ON s.child_id = c.id AND s.ended_at IS NOT NULL
      WHERE c.parent_id = ?
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `,
    [req.session.parentId]
  );

  const recentSummaries = await all(
    `
      SELECT
        s.id,
        s.ended_at,
        s.summary,
        c.name AS child_name
      FROM sessions s
      INNER JOIN children c ON c.id = s.child_id
      WHERE c.parent_id = ? AND s.ended_at IS NOT NULL
      ORDER BY s.ended_at DESC
      LIMIT 8
    `,
    [req.session.parentId]
  );

  res.render('parent-dashboard', {
    pageTitle: 'Parent Dashboard',
    children,
    recentSummaries
  });
});

app.get('/parent/children/new', requireParent, (req, res) => {
  res.render('child-new', { pageTitle: 'Add Child Profile' });
});

app.post('/parent/children/new', requireParent, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const age = Number.parseInt(String(req.body.age || ''), 10);
  const pin = String(req.body.pin || '').trim();

  if (!name || name.length > 40 || Number.isNaN(age) || age < 6 || age > 12 || !/^\d{4}$/.test(pin)) {
    setFlash(req, 'error', 'Use a name, age 6-12, and a 4-digit PIN.');
    res.redirect('/parent/children/new');
    return;
  }

  const pinHash = await bcrypt.hash(pin, 10);
  await run('INSERT INTO children (parent_id, name, age, pin_hash) VALUES (?, ?, ?, ?)', [
    req.session.parentId,
    name,
    age,
    pinHash
  ]);

  setFlash(req, 'success', `Profile created for ${name}.`);
  res.redirect('/parent/dashboard');
});

app.get('/child/login', async (req, res) => {
  const children = await all('SELECT id, name, age FROM children ORDER BY name ASC');
  res.render('child-login', { pageTitle: 'Child PIN Login', children });
});

app.post('/child/login', async (req, res) => {
  const childId = Number.parseInt(String(req.body.childId || ''), 10);
  const pin = String(req.body.pin || '').trim();

  if (Number.isNaN(childId) || !/^\d{4}$/.test(pin)) {
    setFlash(req, 'error', 'Pick your name and enter 4 numbers.');
    res.redirect('/child/login');
    return;
  }

  const child = await get('SELECT id, name, pin_hash FROM children WHERE id = ?', [childId]);
  if (!child) {
    setFlash(req, 'error', 'Profile not found.');
    res.redirect('/child/login');
    return;
  }

  const matches = await bcrypt.compare(pin, child.pin_hash);
  if (!matches) {
    setFlash(req, 'error', 'That PIN is not right. Try again.');
    res.redirect('/child/login');
    return;
  }

  req.session.childId = child.id;
  req.session.childName = child.name;
  req.session.parentId = null;
  req.session.currentSessionId = null;

  setFlash(req, 'success', `Hi ${child.name}! Let us learn together.`);
  res.redirect('/child/session');
});

app.post('/child/logout', (req, res) => {
  req.session.childId = null;
  req.session.childName = null;
  req.session.currentSessionId = null;
  setFlash(req, 'success', 'Bye! See you next time.');
  res.redirect('/');
});

app.get('/child/session', requireChild, async (req, res) => {
  let messages = [];

  if (req.session.currentSessionId) {
    messages = await all(
      'SELECT sender, content, created_at FROM messages WHERE session_id = ? ORDER BY id ASC',
      [req.session.currentSessionId]
    );
  }

  res.render('child-session', {
    pageTitle: 'Spark Chat',
    messages
  });
});

app.post('/child/session/message', requireChild, async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 500) {
    res.status(400).json({ error: 'Write a short message first.' });
    return;
  }

  let sessionId = req.session.currentSessionId;
  if (!sessionId) {
    const sessionResult = await run('INSERT INTO sessions (child_id) VALUES (?)', [req.session.childId]);
    sessionId = sessionResult.id;
    req.session.currentSessionId = sessionId;
  }

  await run('INSERT INTO messages (session_id, sender, content) VALUES (?, ?, ?)', [
    sessionId,
    'child',
    content
  ]);

  const recentMessages = await all(
    'SELECT sender, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 14',
    [sessionId]
  );

  const orderedForModel = [...recentMessages].reverse();
  const reply = await generateCoachReply(req.session.childName || 'friend', orderedForModel);

  await run('INSERT INTO messages (session_id, sender, content) VALUES (?, ?, ?)', [
    sessionId,
    'coach',
    reply
  ]);

  res.json({ reply });
});

app.post('/child/session/end', requireChild, async (req, res) => {
  const sessionId = req.session.currentSessionId;
  if (!sessionId) {
    setFlash(req, 'error', 'No active session to end yet.');
    res.redirect('/child/session');
    return;
  }

  const session = await get('SELECT id, child_id FROM sessions WHERE id = ?', [sessionId]);
  if (!session || session.child_id !== req.session.childId) {
    req.session.currentSessionId = null;
    setFlash(req, 'error', 'Session not found.');
    res.redirect('/child/session');
    return;
  }

  const sessionMessages = await all(
    'SELECT sender, content FROM messages WHERE session_id = ? ORDER BY id ASC',
    [sessionId]
  );

  const summary = await generateSessionSummary(req.session.childName || 'friend', sessionMessages);
  await run('UPDATE sessions SET ended_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?', [summary, sessionId]);

  req.session.currentSessionId = null;
  res.redirect(`/child/session/${sessionId}/summary`);
});

app.get('/child/session/:id/summary', requireChild, async (req, res) => {
  const sessionId = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(sessionId)) {
    res.redirect('/child/session');
    return;
  }

  const sessionSummary = await get(
    `
      SELECT s.id, s.summary, s.ended_at, c.name AS child_name
      FROM sessions s
      INNER JOIN children c ON c.id = s.child_id
      WHERE s.id = ? AND s.child_id = ?
    `,
    [sessionId, req.session.childId]
  );

  if (!sessionSummary) {
    setFlash(req, 'error', 'Summary not found.');
    res.redirect('/child/session');
    return;
  }

  res.render('session-summary', {
    pageTitle: 'Session Summary',
    summary: sessionSummary
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  setFlash(req, 'error', 'Something went wrong. Please try again.');
  res.status(500).redirect('/');
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Spark Coach running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database init failed:', error);
    process.exit(1);
  });
