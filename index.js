#!/usr/bin/env node

if (!process.env.__SUPPRESS_EXP_WARNING__) {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, __SUPPRESS_EXP_WARNING__: '1' } }
  )
  process.exit(r.status)
}

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

function getDefaultDbPath() {
    const homeDir = os.homedir();

    // Windows: %USERPROFILE%\.local\share\opencode\opencode.db
    // macOS & Linux: ~/.local/share/opencode/opencode.db
    return path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
}

const args = process.argv.slice(2);
const command = args[0];

let dbPath = null;
let skipPrompt = false;
let isCustomPath = false;
let forceCleanup = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
        dbPath = path.resolve(args[i + 1]);
        isCustomPath = true;
        i++;
    } else if (args[i] === '-y' || args[i] === '--yes') {
        skipPrompt = true;
    } else if (args[i] === '--force') {
        forceCleanup = true;
    }
}

// 如果使用者沒有指定路徑，使用自動偵測的路徑
if (!dbPath) {
    dbPath = getDefaultDbPath();
}

function isOpencodeRunning() {
    try {
        if (process.platform === 'win32') {
            const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq opencode.*', '/NH'], { encoding: 'utf8' });
            if (res.error) return null;
            // No match prints a locale-dependent INFO line; only PID rows
            // contain "opencode".
            return res.stdout ? /opencode/i.test(res.stdout) : false;
        }
        // macOS & Linux: exit code 0 means at least one matching process
        const res = spawnSync('pgrep', ['-x', 'opencode'], { encoding: 'utf8' });
        if (res.error) return null;
        return res.status === 0;
    } catch {
        return null; // Cannot determine, let the caller decide
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;

    // Files beyond ~1000 MB switch to a GB headline with the exact MB value
    // in parentheses, e.g. "1.06GB (1013.63 MB)"
    if (bytes >= 1000 * k * k) {
        const gb = (bytes / 1e9).toFixed(2); // 1GB = 1000MB (disk size convention)
        const mb = (bytes / (k * k)).toFixed(2);
        return `${gb}GB (${mb} MB)`;
    }

    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function askConfirmation(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

function analyzeDatabase() {
    if (!fs.existsSync(dbPath)) {
        console.error(`❌ Error: Database not found at ${dbPath}`);
        if (!isCustomPath) {
            console.log(`💡 Tip: OpenCode might not be installed, or you need to specify the path using --db <path>`);
        }
        process.exit(1);
    }

    const stats = fs.statSync(dbPath);
    console.log(`\n📊 Analyzing Database: ${dbPath}`);
    if (!isCustomPath) console.log(`   (Auto-detected OS default path)`);
    console.log(`=================================================`);
    console.log(`Physical File Size: ${formatBytes(stats.size)}`);

    try {
        const db = new DatabaseSync(dbPath);

        const pageSize = db.prepare('PRAGMA page_size').get().page_size;
        const pageCount = db.prepare('PRAGMA page_count').get().page_count;
        const freelistCount = db.prepare('PRAGMA freelist_count').get().freelist_count;

        const totalSize = pageSize * pageCount;
        const freelistSize = pageSize * freelistCount;
        const liveData = totalSize - freelistSize;
        const wastePercentage = totalSize > 0 ? ((freelistSize / totalSize) * 100).toFixed(1) : 0;

        console.log(`Live Data Size:     ${formatBytes(liveData)}`);
        console.log(`Unused Space:       ${formatBytes(freelistSize)} (${wastePercentage}% bloated)`);
        console.log(`=================================================\n`);

        console.log(`📈 Table Statistics:`);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const emptyTables = [];
        for (const t of tables) {
            const rowCount = db.prepare(`SELECT COUNT(*) as count FROM "${t.name}"`).get().count;
            if (rowCount === 0) {
                emptyTables.push(t.name);
            } else {
                console.log(` - ${t.name}: ${rowCount} rows`);
            }
        }
        if (emptyTables.length > 0) {
            console.log(` - 0 rows: ${emptyTables.join(', ')}`);
        }

        const hasMessages = tables.some(t => t.name === 'messages');
        if (hasMessages) {
            console.log(`\n✉️  Biggest Messages Top 3:`);
            try {
                const columns = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
                const textCol = columns.includes('content') ? 'content' : (columns.includes('text') ? 'text' : null);

                if (textCol) {
                    const topMessages = db.prepare(`SELECT id, length(${textCol}) as len FROM messages ORDER BY len DESC LIMIT 3`).all();
                    topMessages.forEach((msg, idx) => {
                        console.log(` ${idx + 1}. ID: ${msg.id} | Size: ${formatBytes(msg.len)}`);
                    });
                }
            } catch (e) {
                console.log(` (Could not analyze message sizes due to schema differences)`);
            }
        }

        db.close();
        console.log(`\n💡 Tip: If Unused Space is large, run 'cleanup' command to reclaim it.\n`);

    } catch (err) {
        console.error(`❌ Failed to analyze database. Ensure you are using Node.js >= 22.5.0.`);
        console.error(err.message);
    }
}

async function cleanupDatabase() {
    if (!fs.existsSync(dbPath)) {
        console.error(`❌ Error: Database not found at ${dbPath}`);
        process.exit(1);
    }

    const running = isOpencodeRunning();
    if (running === null) {
        console.log(`⚠️  Could not determine whether OpenCode is running.`);
        console.log(`   If it is running, the backup may be inconsistent and VACUUM may fail.`);
    } else if (running && !forceCleanup) {
        console.error(`❌ OpenCode is currently running. Aborting cleanup to protect data.`);
        console.error(`   Close OpenCode first, or run again with --force to override.`);
        process.exit(1);
    } else if (running && forceCleanup) {
        console.log(`⚠️  OpenCode is running; continuing due to --force.`);
        console.log(`   VACUUM may fail with SQLITE_BUSY and the backup may be inconsistent.`);
    }

    console.log(`\n🧹 Preparing to cleanup: ${dbPath}`);
    if (!isCustomPath) console.log(`   (Auto-detected OS default path)`);

    if (!skipPrompt) {
        const proceed = await askConfirmation(`Are you sure you want to optimize this database? (y/N): `);
        if (!proceed) {
            console.log("Cleanup cancelled by user.");
            return;
        }
    }

    let db;
    try {
        db = new DatabaseSync(dbPath);
        db.exec('PRAGMA busy_timeout = 5000;');
    } catch (err) {
        console.error(`❌ Error: Database is currently locked. Please close OpenCode first!`);
        process.exit(1);
    }

    try {
        const backupPath = `${dbPath}.backup_${Date.now()}`;
        console.log(`📦 Creating backup at: ${backupPath}...`);

        // Copying the main db file alone is not enough with WAL mode:
        // un-checkpointed transactions live in the -wal sidecar and would
        // be missing from a db-only backup.
        fs.copyFileSync(dbPath, backupPath);
        for (const suffix of ['-wal', '-shm']) {
            const sidecar = `${dbPath}${suffix}`;
            if (fs.existsSync(sidecar)) {
                fs.copyFileSync(sidecar, `${backupPath}${suffix}`);
            }
        }

        console.log(`🔍 Running initial integrity check...`);
        const preCheck = db.prepare('PRAGMA integrity_check').get();
        if (preCheck.integrity_check !== 'ok') {
            throw new Error(`Integrity check failed: ${preCheck.integrity_check}. Aborting cleanup to protect data.`);
        }

        console.log(`⚙️  Enabling incremental auto_vacuum...`);
        db.exec('PRAGMA auto_vacuum = INCREMENTAL;');

        const oldSize = fs.statSync(dbPath).size;
        console.log(`🗜️  Vacuuming database (this might take a moment)...`);
        db.exec('VACUUM;');

        // In WAL mode, VACUUM writes the fully rebuilt image into the -wal
        // sidecar, leaving it as large as the whole database. Release any
        // freelist pages (auto_vacuum is incremental here) and then truncate
        // the WAL back to zero, otherwise the huge WAL stays on disk.
        db.exec('PRAGMA incremental_vacuum;');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

        console.log(`🔍 Running final integrity check...`);
        const postCheck = db.prepare('PRAGMA integrity_check').get();
        if (postCheck.integrity_check !== 'ok') {
            throw new Error(`Post-cleanup integrity check failed! Please restore from backup: ${backupPath}`);
        }

        // Stat after checkpointing so the sizes below reflect the WAL merge.
        const newSize = fs.statSync(dbPath).size;
        const walSize = (() => {
            const wal = `${dbPath}-wal`;
            return fs.existsSync(wal) ? fs.statSync(wal).size : 0;
        })();
        const saved = oldSize - newSize;

        console.log(`\n✅ Cleanup Successful!`);
        console.log(`=================================================`);
        console.log(`Size Before: ${formatBytes(oldSize)}`);
        console.log(`Size After:  ${formatBytes(newSize)}`);
        console.log(`WAL After:   ${formatBytes(walSize)}`);
        console.log(`Space Saved: ${formatBytes(saved > 0 ? saved : 0)}`);
        console.log(`=================================================\n`);

    } catch (err) {
        console.error(`\n❌ Fatal Error during cleanup: ${err.message}`);
    } finally {
        if (db) db.close();
    }
}

if (command === 'analyze') {
    analyzeDatabase();
} else if (command === 'cleanup') {
    cleanupDatabase();
} else {
    const displayDefault = getDefaultDbPath();
    console.log(`
Usage: ocdbm <command> [options]

Commands:
  analyze    Show a health report of the database
  cleanup    Safely reclaim unused space and optimize

Options:
  --db <path>   Path to the SQLite database
                (If not provided, auto-detects based on OS)
  -y, --yes     Skip confirmation prompts during cleanup
  --force       Allow cleanup even if OpenCode is running

Auto-detected path for your system:
  ${displayDefault}

Examples:
  ocdbm analyze
  ocdbm cleanup -y
  ocdbm analyze --db ./custom-folder/opencode.db
    `);
}
