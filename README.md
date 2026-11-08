# opencode-db-minimize (ocdbm)

A **zero-dependency** command-line tool to analyze and safely minimize the SQLite database used by [OpenCode](https://opencode.ai). Over time, OpenCode's database can grow bloated with conversation history — even "deleted" data may still occupy disk space. `ocdbm` analyzes the bloat and reclaims that space via `VACUUM`.

## Requirements

- **Node.js >= 22.5.0** (uses the built-in `node:sqlite` module — nothing to install)

## Installation

```bash
npm install -g @sk5s/opencode-db-minimize
```

After installation, use the `ocdbm` command.

## Usage with npx

No installation needed — run it directly with `npx`:

```bash
npx @sk5s/opencode-db-minimize analyze
npx @sk5s/opencode-db-minimize cleanup
```

You can add `-y` or `--db <path>` in the same way, e.g.:

```bash
npx @sk5s/opencode-db-minimize cleanup -y
```

## CLI Usage

```text
Usage: ocdbm <command> [options]

Commands:
  analyze    Show a health report of the database
  cleanup    Safely reclaim unused space and optimize the database

Options:
  --db <path>   Path to the SQLite database
                (auto-detected based on OS if not provided)
  -y, --yes     Skip confirmation prompts during cleanup
  --force       Allow cleanup even if OpenCode is running
```

### Analyze the database

Shows the file size, unused space (bloat percentage), row counts per table, and the top 3 largest messages:

```bash
ocdbm analyze
```

### Clean up the database

The flow includes: detecting whether OpenCode is running, creating a full backup (including the `-wal` / `-shm` sidecar files), pre- and post-integrity checks, then `VACUUM` + incremental vacuum + WAL checkpoint:

```bash
ocdbm cleanup           # asks for confirmation (y/N) first
ocdbm cleanup -y        # skip the confirmation prompt
```

### Custom database path

```bash
ocdbm analyze --db ./custom-folder/opencode.db
ocdbm cleanup --db /path/to/opencode.db -y
```

### Default database path (auto-detected)

- Windows: `%USERPROFILE%\.local\share\opencode\opencode.db`
- macOS / Linux: `~/.local/share/opencode/opencode.db`

## Example Output

```text
📊 Analyzing Database: /home/user/.local/share/opencode/opencode.db
=================================================
Physical File Size: 1.06GB (1013.63 MB)
Live Data Size:     512.40 MB
Unused Space:       501.23 MB (49.4% bloated)
=================================================
```

## ⚠️ Disclaimer: Use at Your Own Risk

**This tool directly modifies OpenCode's SQLite database file. Use it at your own risk.**

- This software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.
- While `cleanup` creates a backup and runs integrity checks first, data loss or a broken OpenCode installation may still occur due to hardware failure, insufficient disk space, process interruption, OpenCode currently running, or unexpected schema changes.
- The risk is higher when using `--force` to bypass the "OpenCode is running" guard or `-y` to skip the confirmation prompt — always verify the backup exists before proceeding.
- Users are responsible for knowing where the backup file is located and validating any important data themselves.
- **The author and contributors are not liable for any data loss, damage, or other consequences resulting from the use of this tool.**

Recommended practice: keep at least one additional backup of your OpenCode data (e.g., a snapshot of `~/.local/share/opencode`) before running `cleanup`.

## License

[MIT](./LICENSE)
