import express from 'express';
import session from 'express-session';
import multer from 'multer';
import bcrypt from 'bcrypt';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const db = new Database('repo.db');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT NOT NULL,
    asset_type TEXT CHECK(asset_type IN ('full_model', 'skin_only')) NOT NULL,
    associated_model TEXT,
    glb_path TEXT,
    texture_path TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

try {
    db.exec(`ALTER TABLE assets ADD COLUMN votes INTEGER DEFAULT 0;`);
    console.log("Successfully migrated database to add votes column.");
} catch (err) {
    if (!err.message.includes("duplicate column name")) {
        console.error("Database migration error:", err);
        db.exec(`
        CREATE TABLE IF NOT EXISTS asset_votes (
            asset_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            PRIMARY KEY (asset_id, user_id),
            FOREIGN KEY(asset_id) REFERENCES assets(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        `);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(session({
    secret: 'cubyz-secret-key',
    resave: false,
    saveUninitialized: false
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folderName = (req.body.title || 'untitled').replace(/[^a-z0-9-_]/gi, '_').toLowerCase();
        const targetDir = path.join(__dirname, 'uploads', folderName);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

app.get('/api/me', (req, res) => {
    if (req.session.userId) {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.userId);
        res.json({ loggedIn: true, username: user.username });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    try {
        const hash = await bcrypt.hash(password, 10);
        const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
        const info = stmt.run(username, hash);
        req.session.userId = info.lastInsertRowid;

        req.session.save(() => res.json({ success: true }));
    } catch (err) {
        res.status(400).json({ error: 'Username already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (user && await bcrypt.compare(password, user.password_hash)) {
        req.session.userId = user.id;

        req.session.save(() => res.json({ success: true }));
        return;
    }
    res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/assets', (req, res) => {
    const sortBy = req.query.sort || 'newest';
    let orderByClause = 'ORDER BY assets.id DESC';

    if (sortBy === 'oldest') {
        orderByClause = 'ORDER BY assets.id ASC';
    } else if (sortBy === 'votes') {
        orderByClause = 'ORDER BY assets.votes DESC, assets.id DESC';
    }

    try {
        const stmt = db.prepare(`
        SELECT assets.*, users.username
        FROM assets
        JOIN users ON assets.user_id = users.id
        ${orderByClause}
        `);
        const rows = stmt.all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/assets/:id/vote', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const assetId = Number(req.params.id);
    const userId = req.session.userId;

    const asset = db.prepare(
        'SELECT id FROM assets WHERE id = ?'
    ).get(assetId);

    if (!asset) {
        return res.status(404).json({ error: 'Asset not found' });
    }

    const alreadyVoted = db.prepare(`
    SELECT 1
    FROM asset_votes
    WHERE asset_id = ? AND user_id = ?
    `).get(assetId, userId);

    if (alreadyVoted) {
        return res.status(400).json({ error: 'You have already voted for this asset.' });
    }

    const transaction = db.transaction(() => {
        db.prepare(`
        INSERT INTO asset_votes (asset_id, user_id)
        VALUES (?, ?)
        `).run(assetId, userId);

        db.prepare(`
        UPDATE assets
        SET votes = votes + 1
        WHERE id = ?
        `).run(assetId);
    });

    transaction();

    res.json({ success: true });
});

app.post('/api/upload', upload.fields([{ name: 'glb' }, { name: 'texture' }]), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title, asset_type, associated_model } = req.body;
    const folderName = title.replace(/[^a-z0-9-_]/gi, '_').toLowerCase();

    const glb_path = req.files['glb'] ? `/uploads/${folderName}/${req.files['glb'][0].filename}` : null;
    const texture_path = req.files['texture'] ? `/uploads/${folderName}/${req.files['texture'][0].filename}` : null;

    const stmt = db.prepare(`
    INSERT INTO assets (user_id, title, asset_type, associated_model, glb_path, texture_path)
    VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(req.session.userId, title, asset_type, associated_model || null, glb_path, texture_path);

    res.json({ success: true });
});

app.delete('/api/assets/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });

    const stmt = db.prepare('DELETE FROM assets WHERE id = ? AND user_id = ?');
    const result = stmt.run(req.params.id, req.session.userId);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Not found' });
    }

    res.json({ success: true });
});

app.listen(6767, () => console.log('Server running on http://localhost:6767'));
