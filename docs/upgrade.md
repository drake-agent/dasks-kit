# Upgrading Dasks

A board is two things: the kit (this repo, the code) and the board's data repo (`~/.dasks/data`, a git repo). An
upgrade replaces the kit; the board's files are brought up to the new kit's schema when the server starts.

## Schema versions

`data/schema.json` in the data repo says which version the board's files follow (`{"schema": 3}`); a new board starts at
the kit's version. Steps so far: 0 → 1 writes the file (a board created before versioning has none); 1 → 2 drops three
retired review fields (`review_verdict`, `review_pass`, `review_cap`) from task files. At start the
server runs the kit's migrations (`src/lib/migrate.ts`) in order, from the board's version up to the kit's:

1. It takes a backup of the whole data repo first: `.git/dasks-backups/<time>-schema-<from>.bundle` (every ref and all
   history).
2. Each migration is one commit (`dasks: board schema N -> N+1 (…)`), so `git log` shows what changed.
3. The server log says what ran and where the backup is: `migrate: board schema 0 -> 1 (…); backup before it: …`.

A board whose schema is newer than the kit is refused: the server does not start (an older kit must not write a format
it does not know). A migration that fails leaves the board as it was at the last finished step; the server still starts,
but `/api/health` is not ready (`schema.ok: false`) until it is fixed.

## Upgrade

1. **Back up.** Stop the runner on every Mac (`launchctl bootout gui/$(id -u)/dev.dasks.runner`, or let
   `./uninstall.sh` do it), then copy the board yourself; the automatic bundle is a second copy, not the only one:

   ```bash
   git -C ~/.dasks/data status --short          # should print nothing; commit or put back anything listed
   git -C ~/.dasks/data bundle create ~/dasks-board-$(date +%Y%m%d).bundle --all
   cp -p ~/.dasks/client.json ~/dasks-client-$(date +%Y%m%d).json
   ```

2. **Upgrade the kit.** In the kit folder: `git pull --ff-only` (or unpack the new release over a fresh folder), then
   run `./install.sh` again with the same options as the first time. It keeps the board, the passphrase and the tokens,
   restarts the board and waits until `/api/health` says ready.

3. **Verify.**

   ```bash
   curl -fsS http://127.0.0.1:4747/api/health   # 200 and "ready": true; a 503 names the part that is not
   dasks check                                  # 0 errors
   git -C ~/.dasks/data log --oneline -3        # the migration commits, if any ran
   ```

   Then start the runners again (`./install.sh --with-runner` on each Mac that had one).

## Roll back

1. Stop the board: `launchctl bootout gui/$(id -u)/dev.dasks.server`.
2. Put the kit back: `git checkout <previous tag or commit>` in the kit folder (or the previous release folder).
3. If a migration ran, put the board back too, since the older kit refuses the newer schema. Either reset to the commit
   before the first `dasks: board schema` commit, which keeps everything written before the upgrade:

   ```bash
   git -C ~/.dasks/data log --oneline --grep '^dasks: board schema'   # the first one's parent is the target
   git -C ~/.dasks/data reset --hard <that commit>^
   ```

   or restore the whole repo from a bundle (the one you made, or `.git/dasks-backups/…`):

   ```bash
   mv ~/.dasks/data ~/.dasks/data.after-upgrade
   git clone -q ~/dasks-board-YYYYMMDD.bundle ~/.dasks/data
   cp -Rp ~/.dasks/data.after-upgrade/run ~/.dasks/data/   # live state (fleet, leases), never committed
   ```

   Cards written after the upgrade are lost either way; they stay in `data.after-upgrade` to copy back by hand.
4. Run the older kit's `./install.sh` with your options and check `/api/health` as above.

## Backup and restore

The board's data repo lives on one disk. To keep a copy elsewhere, make an empty private repo (on GitHub or any git
server this Mac can push to without a prompt: an ssh key or a credential helper) and set `backup` in
`~/.dasks/data/config.json`, then restart the board:

```json
"backup": { "remote": "git@github.com:you/dasks-board-backup.git", "every_min": 10 }
```

- Every `every_min` minutes (default 10) the board pushes its commits to one branch named for this board,
  `dasks-board-<machine>` (`branch` changes it). Nothing else is pushed: no other branch, no tag, never `--force`. A remote
  branch that has commits this board does not is reported, not overwritten.
- Only commits leave the Mac. `run/` (live state) is not committed, and the token store, the passphrase and the login
  secrets live in `~/.dasks`, outside the data repo. Before each push the paths of every new commit are checked anyway;
  a commit that carries `run/…`, a key, a token store or a passphrase file stops the push.
- Only these remote forms are taken: `https://host/path` (no user name or token in it: use a credential helper),
  `ssh://[user@]host/path`, `user@host:path` and an absolute local path. Anything else, any `<transport>::` form
  included, is refused at start. `/api/backup` and `dasks backup status` show the remote's host and path only.
- A failed push never stops the board. After three in a row, `/api/health` lists a warning (still 200), `dasks check`
  prints a `run/backup.json` line with the git error, and the daily summary lists it.

```bash
dasks backup status     # remote, branch, last good push, failures in a row and the last error
dasks backup now        # push now
```

To restore on a new Mac (or after a lost disk): install the kit, then put the backup in place of the board and point
the board at it.

```bash
git clone --branch dasks-board-<machine> git@github.com:you/dasks-board-backup.git ~/dasks-board
launchctl bootout gui/$(id -u)/dev.dasks.server            # if a board is running
```

Either move the clone to `~/.dasks/data` (where `install.sh` looks), or keep it where it is and run the board with
`DASKS_ROOT` pointing at it (`DASKS_ROOT=~/dasks-board bin/dasks-server`; for the LaunchAgent, change `DASKS_ROOT` in
`~/Library/LaunchAgents/dev.dasks.server.plist`). Run `./install.sh` again with your options so the passphrase and the
tokens exist on that Mac, then check `curl -fsS http://127.0.0.1:4747/api/health` and `dasks check`. Live state
(`run/`: fleet heartbeats, leases, the summary) starts empty; runners send heartbeats again within a minute.
